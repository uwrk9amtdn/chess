// The admin page: logging in, then the live state, updates, statistics and
// game records, all from /admin/api (see server/panel.js).
//
// Everything that comes from players (their names, above all) is put on the
// page as text, never as HTML.

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const OVERVIEW_EVERY_MS = 10_000;
const STATS_EVERY_MS = 60_000;
const RANGES = [7, 30, 90, 365];

// The site's theme, as the main page keeps it.
try {
  const theme = localStorage.getItem('games.theme');
  if (theme) document.documentElement.dataset.theme = theme;
} catch {
  // Without storage the page has the light theme.
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

// ---- talking to the server ----

class LoggedOut extends Error {}

async function api(method, path, body) {
  const res = await fetch(`/admin/api/${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') throw new LoggedOut();
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { data, status: res.status });
  return data;
}

// ---- formatting ----

const number = (n) => Math.round(n).toLocaleString();
const compact = (n) => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(Math.round(n * 10) / 10));

function duration(ms) {
  const seconds = Math.round(ms / 1000);
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${seconds % 60}s`;
  return `${seconds}s`;
}

const shortDay = (day) => new Date(`${day}T12:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
const shortHour = (hour) => {
  const [day, h] = hour.split('T');
  return `${shortDay(day)} ${h}:00`;
};
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// ---- logging in ----

let retryTimer = null;

function showLogin(message = '', error = false) {
  $('login').hidden = false;
  $('panel').hidden = true;
  $('logout').hidden = true;
  $('refreshed').textContent = '';
  $('loginMessage').textContent = message;
  $('loginMessage').classList.toggle('error', error);
  stopRefreshing();
}

// Counts down a wait imposed after wrong passwords, with the button off.
function holdLogin(ms) {
  clearInterval(retryTimer);
  const until = Date.now() + ms;
  const tick = () => {
    const left = until - Date.now();
    $('loginButton').disabled = left > 0;
    if (left <= 0) {
      clearInterval(retryTimer);
      $('loginMessage').textContent = '';
      return;
    }
    $('loginMessage').classList.add('error');
    $('loginMessage').textContent = `Too many wrong passwords. Try again in ${duration(left)}.`;
  };
  tick();
  retryTimer = setInterval(tick, 1000);
}

async function start() {
  let session;
  try {
    session = await api('GET', 'session');
  } catch {
    return showLogin('The server cannot be reached.', true);
  }
  if (session.loggedIn) return showPanel();
  showSeen(session.seen);
  if (!session.passwordSet) {
    showLogin(session.noPassword);
    $('loginButton').disabled = true;
    return;
  }
  if (!session.https) {
    showLogin('Log in over HTTPS: the password must not cross the network unencrypted. If this page is open over https:// already, the proxy settings need a look: see "What the server sees" below and DEPLOY.md.', true);
    $('loginButton').disabled = true;
    return;
  }
  showLogin();
  if (session.retryAfterMs) holdLogin(session.retryAfterMs);
  $('password').focus();
}

// The connection as the server sees it: the address it comes from, the
// proxy's headers, and what the server makes of them.
function showSeen(seen) {
  if (!seen) return;
  const shown = (v) => (v === null || v === undefined ? '(none)' : String(v));
  $('seenTable').replaceChildren(...[
    ['Connection from', seen.connectionFrom],
    ['X-Real-IP', seen.xRealIp],
    ['X-Forwarded-For', seen.xForwardedFor],
    ['X-Forwarded-Proto', seen.xForwardedProto],
    ['Taken as visitor address', seen.takenAs.address],
    ['Through the proxy', seen.takenAs.throughProxy ? 'yes' : 'no'],
    ['Counts as HTTPS', seen.takenAs.https ? 'yes' : 'no'],
  ].map(([label, value]) => el('tr', {}, el('th', { textContent: label }), el('td', { textContent: shown(value) }))));
  $('seen').hidden = false;
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginButton').disabled = true;
  try {
    await api('POST', 'login', { password: $('password').value });
    $('password').value = '';
    showPanel();
  } catch (err) {
    $('password').select();
    $('loginButton').disabled = false;
    if (err.data?.retryAfterMs) holdLogin(err.data.retryAfterMs);
    else showLogin(err.message, true);
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', 'logout', {}).catch(() => {});
  showLogin('Logged out.');
});

// ---- the panel ----

let overviewTimer = null;
let statsTimer = null;
let days = 30;
let games = []; // { id, name } in a fixed order: a game's colour follows it

function stopRefreshing() {
  clearInterval(overviewTimer);
  clearInterval(statsTimer);
}

// Every request after logging in goes through here: a session that has
// ended brings the login back.
function guarded(work) {
  return work().catch((err) => {
    if (err instanceof LoggedOut) showLogin('Your session has ended. Log in again.');
    else console.error(err);
  });
}

function showPanel() {
  $('login').hidden = true;
  $('panel').hidden = false;
  $('logout').hidden = false;
  stopRefreshing();
  guarded(async () => {
    await loadOverview();
    await loadFeedback();
    await loadStats();
    await loadRecords();
  });
  overviewTimer = setInterval(() => guarded(loadOverview), OVERVIEW_EVERY_MS);
  statsTimer = setInterval(() => guarded(loadStats), STATS_EVERY_MS);
}

const colourOf = (game) => `var(--series-${(games.findIndex((g) => g.id === game) % 8) + 1})`;
const nameOf = (game) => games.find((g) => g.id === game)?.name ?? game;

function tile(label, value, note = '', hero = false) {
  return el('div', { className: `tile${hero ? ' hero' : ''}` },
    el('span', { className: 'label', textContent: label }),
    el('span', { className: 'value', textContent: value }),
    el('span', { className: 'note', textContent: note }));
}

function table(target, headings, rows, caption = '') {
  const node = typeof target === 'string' ? $(target) : target;
  if (!rows.length) {
    node.replaceChildren();
    return node;
  }
  const head = el('tr', {}, ...headings.map((h) => el('th', { textContent: h.label ?? h, className: h.num ? 'num' : '' })));
  node.replaceChildren(
    ...(caption ? [el('caption', { textContent: caption })] : []),
    el('thead', {}, head),
    el('tbody', {}, ...rows.map((row) => el('tr', {}, ...row.map((cell, i) => {
      const td = el('td', { className: headings[i].num ? 'num' : '' });
      td.append(cell instanceof Node ? cell : String(cell));
      return td;
    })))));
  return node;
}

async function loadOverview() {
  const o = await api('GET', 'overview');
  games = o.games;
  const online = o.players.filter((p) => p.connected).length;
  const playing = o.players.filter((p) => p.game).length;
  const vsBot = o.matches.filter((m) => m.vsBot).length;
  const watching = o.matches.reduce((sum, m) => sum + m.spectators, 0);
  const [commit, ...about] = (o.version ?? 'unknown').split(' ');
  $('tiles').replaceChildren(
    tile('Players online', number(online), `${playing} playing`, true),
    tile('Games in progress', number(o.matches.length), `${vsBot} against the bot`),
    tile('Watching', number(watching), 'spectators'),
    tile('Up for', duration(o.now - o.startedAt), `since ${when(o.startedAt)}`),
    tile('Memory', `${o.memoryMb} MB`, `${o.heapMb} MB of it JavaScript`),
    tile('Version', commit, about.join(' ')),
    tile('Feedback', number(o.unreadFeedback), 'unread'));
  // New feedback since the list was drawn: draw it again.
  if (shownUnread !== null && o.unreadFeedback !== shownUnread) guarded(loadFeedback);
  const r = o.restart;
  $('restartLine').textContent = !r ? ''
    : r.ready ? 'An update is about to be applied.'
      : r.msLeft > 0 ? `An update is waiting: ${duration(r.msLeft)} of warning left, then it waits for ${r.games} game(s) in progress.`
        : `An update is waiting for ${r.games} game(s) in progress to end. New games cannot start.`;
  table('liveGames', ['Game', 'Players', { label: 'Started', num: false }, { label: 'Watching', num: true }],
    o.matches.map((m) => [nameOf(m.game), m.players.join(' vs '), `${duration(o.now - m.startedAt)} ago`, m.spectators]),
    'Games in progress');

  const u = o.updates;
  for (const id of ['checkUpdates', 'updateNow']) $(id).disabled = !u.available;
  $('cancelUpdate').disabled = !r;
  $('updateNote').textContent = [
    u.available ? '' : 'The server does not run under deploy/game-room, so it cannot update itself.',
    u.failedCommit ? `Commit ${u.failedCommit} failed its tests and is not applied.` : '',
    u.skippedCommit ? `The update to commit ${u.skippedCommit} was called off; "Update now" applies it.` : '',
  ].filter(Boolean).join(' ');
  $('updateLog').textContent = u.log.join('\n');
  $('refreshed').textContent = `Updated ${new Date(o.now).toLocaleTimeString()}`;

  // The game list for the records, once.
  const select = $('recordsGame');
  if (!select.options.length) {
    select.append(...games.map((g) => el('option', { value: g.id, textContent: g.name })));
  }
}

async function update(action, question) {
  if (!confirm(question)) return;
  await guarded(async () => {
    await api('POST', 'update', { action });
    setTimeout(() => guarded(loadOverview), 1500);
  });
}
$('checkUpdates').addEventListener('click', () => update('check',
  'Look for an update now? If there is one, the players get five minutes\' warning and it waits for games in progress.'));
$('updateNow').addEventListener('click', () => update('now',
  'Update now? New games stop at once, and the server restarts as soon as no game is in progress.'));
$('cancelUpdate').addEventListener('click', () => update('cancel',
  'Call off the waiting update? It will not be tried again until a newer commit is pushed or it is started by hand.'));

// ---- charts ----

// Charts are drawn at the width they have on the page, so their text keeps
// its size; they are drawn again when the window is resized.
const H = 220;
const PAD = { top: 12, right: 44, bottom: 24, left: 40 };

// A clean top for the y axis and its ticks.
function scaleOf(max) {
  if (max <= 0) return { top: 4, ticks: [0, 2, 4] };
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  // Everything charted is counted in whole units, so no step below one.
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough));
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks };
}

// The frame of a chart: caption, the SVG with its grid and axes, a legend,
// a tooltip, and the numbers as a table under "Table".
function frame(id, { title, subtitle, labels, series, top, format, tableLabel }) {
  const figure = $(id);
  const W = Math.max(280, figure.clientWidth - 32);
  const caption = el('figcaption', {}, el('strong', { textContent: title }), el('span', { textContent: subtitle }));
  if (!labels.length) {
    figure.replaceChildren(caption, el('p', { className: 'empty', textContent: 'Nothing recorded yet.' }));
    return null;
  }
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${title}. ${subtitle}` });
  const { ticks } = scaleOf(top);
  const scaleTop = ticks[ticks.length - 1];
  const x0 = PAD.left;
  const x1 = W - PAD.right;
  const y = (v) => H - PAD.bottom - (v / scaleTop) * (H - PAD.top - PAD.bottom);
  const axis = svg('g', { class: 'axis' });
  for (const t of ticks) {
    root.append(svg('line', { class: 'gridline', x1: x0, x2: x1, y1: y(t), y2: y(t) }));
    const label = svg('text', { x: x0 - 6, y: y(t) + 4, 'text-anchor': 'end' });
    label.textContent = compact(t);
    axis.append(label);
  }
  // The first, middle and last labels along the bottom.
  const n = labels.length;
  const xAt = (i) => (n === 1 ? (x0 + x1) / 2 : x0 + (i / (n - 1)) * (x1 - x0));
  for (const i of [...new Set([0, Math.floor((n - 1) / 2), n - 1])]) {
    const label = svg('text', { x: xAt(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' });
    label.textContent = labels[i];
    axis.append(label);
  }
  root.append(axis);
  const tooltip = el('div', { className: 'tooltip', hidden: true });
  const legend = series.length > 1
    ? el('div', { className: 'legend' }, ...series.map((s) => el('span', {}, el('i', { style: `background:${s.colour}` }), s.name)))
    : el('div');
  const details = el('details', {}, el('summary', { textContent: 'Table' }),
    table(el('table', { className: 'adminTable' }), [tableLabel, ...series.map((s) => ({ label: s.name, num: true }))],
      labels.map((l, i) => [l, ...series.map((s) => format(s.values[i]))]).reverse()));
  figure.replaceChildren(caption, root, legend, tooltip, details);
  return { root, tooltip, y, xAt, x0, x1, figure, W };
}

// Shows the values at the point under the pointer, with a cursor line.
function hover(chart, labels, series, format, { dots = true } = {}) {
  const { root, tooltip, xAt, y, figure, W } = chart;
  const cursor = svg('line', { class: 'cursor', y1: PAD.top, y2: H - PAD.bottom, visibility: 'hidden' });
  const marks = series.map((s) => svg('circle', { class: 'dot', r: 4, fill: s.colour, visibility: 'hidden' }));
  root.append(cursor, ...(dots ? marks : []));
  const area = svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
  root.append(area);
  const show = (e) => {
    const box = root.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let i = 0;
    for (let k = 0; k < labels.length; k++) if (Math.abs(xAt(k) - px) < Math.abs(xAt(i) - px)) i = k;
    cursor.setAttribute('x1', xAt(i));
    cursor.setAttribute('x2', xAt(i));
    cursor.setAttribute('visibility', 'visible');
    marks.forEach((m, k) => {
      m.setAttribute('cx', xAt(i));
      m.setAttribute('cy', y(series[k].stackTop?.[i] ?? series[k].values[i]));
      m.setAttribute('visibility', 'visible');
    });
    tooltip.replaceChildren(el('b', { textContent: labels[i] }),
      ...series.map((s) => el('div', {}, el('i', { style: `background:${s.colour}` }), `${s.name}: ${format(s.values[i])}`)));
    tooltip.hidden = false;
    const frameBox = figure.getBoundingClientRect();
    const left = box.left - frameBox.left + (xAt(i) / W) * box.width;
    tooltip.style.left = `${Math.min(Math.max(8, left + 12), frameBox.width - tooltip.offsetWidth - 8)}px`;
    tooltip.style.top = `${box.top - frameBox.top + 8}px`;
  };
  const hide = () => {
    cursor.setAttribute('visibility', 'hidden');
    for (const m of marks) m.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  };
  area.addEventListener('pointermove', show);
  area.addEventListener('pointerdown', show);
  area.addEventListener('pointerleave', hide);
}

// Lines, one per series, each with its last value at its end.
function lineChart(id, { title, subtitle, labels, series, format = number, tableLabel = 'Day' }) {
  const top = Math.max(0, ...series.flatMap((s) => s.values));
  const chart = frame(id, { title, subtitle, labels, series, top, format, tableLabel });
  if (!chart) return;
  const { root, y, xAt } = chart;
  for (const s of series) {
    const points = s.values.map((v, i) => `${xAt(i)},${y(v)}`).join(' ');
    if (series.length === 1) {
      root.append(svg('polygon', {
        class: 'wash', fill: s.colour, points: `${xAt(0)},${y(0)} ${points} ${xAt(labels.length - 1)},${y(0)}`,
      }));
    }
    root.append(svg('polyline', { class: 'line', stroke: s.colour, points }));
    const last = s.values.length - 1;
    root.append(svg('circle', { class: 'dot', r: 4, fill: s.colour, cx: xAt(last), cy: y(s.values[last]) }));
    const label = svg('text', { class: 'endLabel', x: xAt(last) + 8, y: y(s.values[last]) + 4 });
    label.textContent = format(s.values[last]);
    root.append(label);
  }
  hover(chart, labels, series, format);
}

// Columns stacked by series, with a surface gap between the parts.
function stackedChart(id, { title, subtitle, labels, series, format = number, tableLabel = 'Day' }) {
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + s.values[i], 0));
  const chart = frame(id, { title, subtitle, labels, series, top: Math.max(0, ...totals), format, tableLabel });
  if (!chart) return;
  const { root, y, xAt, x0, x1 } = chart;
  const slot = (x1 - x0) / Math.max(1, labels.length);
  const width = Math.max(2, Math.min(24, slot * 0.7));
  const gap = 2;
  labels.forEach((_, i) => {
    let base = 0;
    const parts = series.filter((s) => s.values[i] > 0);
    parts.forEach((s, k) => {
      const yTop = y(base + s.values[i]);
      const yBottom = y(base);
      const h = Math.max(0, yBottom - yTop - (k ? gap : 0));
      const x = xAt(i) - width / 2;
      // The top part's upper corners are rounded; the rest stay square.
      const r = k === parts.length - 1 ? Math.min(4, width / 2, h) : 0;
      root.append(svg('path', {
        fill: s.colour,
        d: `M${x} ${yBottom - (k ? gap : 0)}V${yTop + r}q0 ${-r} ${r} ${-r}H${x + width - r}q${r} 0 ${r} ${r}V${yBottom - (k ? gap : 0)}Z`,
      }));
      base += s.values[i];
    });
  });
  const total = totals[totals.length - 1];
  const label = svg('text', { class: 'endLabel', x: xAt(labels.length - 1) + width / 2 + 4, y: y(total) + 4 });
  label.textContent = format(total);
  root.append(label);
  hover(chart, labels, series, format, { dots: false });
}

// ---- statistics ----

let lastStats = null;

async function loadStats() {
  lastStats = await api('GET', `stats?days=${days}`);
  renderStats();
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => lastStats && !$('panel').hidden && renderStats(), 150);
});

function renderStats() {
  const { days: list, hours } = lastStats;
  const labels = list.map((d) => shortDay(d.day));
  lineChart('playersChart', {
    title: 'Players per day',
    subtitle: 'Different players, and the most online at once',
    labels,
    series: [
      { name: 'Players', colour: 'var(--series-1)', values: list.map((d) => d.players) },
      { name: 'Most online at once', colour: 'var(--series-2)', values: list.map((d) => d.peakOnline) },
    ],
  });
  const ids = games.map((g) => g.id).filter((id) => list.some((d) => d.games[id]));
  stackedChart('gamesChart', {
    title: 'Games per day',
    subtitle: 'Games started, by game',
    labels,
    series: ids.map((id) => ({ name: nameOf(id), colour: colourOf(id), values: list.map((d) => d.games[id]?.started ?? 0) })),
  });
  lineChart('hoursChart', {
    title: 'Last 7 days, by hour',
    subtitle: 'Most players online at once',
    labels: hours.map((h) => shortHour(h.hour)),
    series: [{ name: 'Online', colour: 'var(--series-1)', values: hours.map((h) => h.peakOnline) }],
    tableLabel: 'Hour',
  });
  lineChart('memoryChart', {
    title: 'Memory',
    subtitle: 'Most in use each day, MB',
    labels,
    series: [{ name: 'Memory (MB)', colour: 'var(--series-1)', values: list.map((d) => d.server.rssMaxMb) }],
  });
  lineChart('lagChart', {
    title: 'Slowest response',
    subtitle: 'Longest the server was held up each day, ms',
    labels,
    series: [{ name: 'Delay (ms)', colour: 'var(--series-1)', values: list.map((d) => d.server.lagMaxMs) }],
  });
  table('healthTable',
    ['Day', { label: 'Starts', num: true }, { label: 'Updates', num: true }, { label: 'Errors', num: true },
      { label: 'Connections', num: true }, { label: 'Dropped mid-game', num: true }, { label: 'Chat messages', num: true }],
    list.slice().reverse().map((d) => [shortDay(d.day), d.server.starts, d.server.updates, d.server.errors, d.connections, d.dropped, d.chat]),
    'Per day');
  gameCards(list);
}

// What each game's numbers come to over the days shown.
function gameCards(list) {
  const cards = games.map((g) => {
    const sum = { started: 0, finished: 0, vsBot: 0, durationMs: 0, reasons: {}, options: {}, bots: {} };
    for (const d of list) {
      const day = d.games[g.id];
      if (!day) continue;
      for (const key of ['started', 'finished', 'vsBot', 'durationMs']) sum[key] += day[key];
      for (const [reason, n] of Object.entries(day.reasons)) sum.reasons[reason] = (sum.reasons[reason] ?? 0) + n;
      for (const [option, values] of Object.entries(day.options)) {
        sum.options[option] ??= {};
        for (const [value, n] of Object.entries(values)) sum.options[option][value] = (sum.options[option][value] ?? 0) + n;
      }
      for (const [level, b] of Object.entries(day.bots)) {
        const into = (sum.bots[level] ??= { games: 0, botWins: 0, draws: 0 });
        into.games += b.games;
        into.botWins += b.botWins;
        into.draws += b.draws;
      }
    }
    if (!sum.started && !sum.finished) return null;
    const bars = (counts, limit = 6) => {
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit);
      const max = Math.max(...entries.map(([, n]) => n));
      return el('div', { className: 'bars' }, ...entries.map(([label, n]) => el('div', {},
        el('span', { textContent: label, title: label }),
        el('b', { style: `width:${(n / max) * 100}%;background:${colourOf(g.id)}` }),
        el('em', { textContent: number(n) }))));
    };
    const card = el('div', { className: 'adminCard gameCard' },
      el('h3', {}, el('i', { style: `background:${colourOf(g.id)}` }), g.name),
      el('div', { className: 'figures' },
        el('div', {}, el('strong', { textContent: number(sum.started) }), el('span', { textContent: 'started' })),
        el('div', {}, el('strong', { textContent: sum.finished ? `${Math.round((sum.vsBot / sum.finished) * 100)}%` : '–' }),
          el('span', { textContent: 'against the bot' })),
        el('div', {}, el('strong', { textContent: sum.finished ? duration(sum.durationMs / sum.finished) : '–' }),
          el('span', { textContent: 'average length' }))));
    if (Object.keys(sum.reasons).length) card.append(el('h4', { textContent: 'How they ended' }), bars(sum.reasons));
    for (const [option, values] of Object.entries(sum.options)) {
      card.append(el('h4', { textContent: `Chosen: ${option}` }), bars(values, 5));
    }
    const levels = Object.entries(sum.bots).sort((a, b) => Number(a[0]) - Number(b[0]));
    if (levels.length) {
      card.append(el('h4', { textContent: 'Against the bot' }), table(el('table', { className: 'adminTable' }),
        ['Level', { label: 'Games', num: true }, { label: 'Bot won', num: true }, { label: 'Drawn', num: true }],
        levels.map(([level, b]) => [level, b.games, `${Math.round((b.botWins / b.games) * 100)}%`, b.draws])));
    }
    return card;
  }).filter(Boolean);
  $('gameCards').replaceChildren(...(cards.length ? cards : [el('p', { className: 'empty', textContent: 'No games in this period.' })]));
}

$('range').append(...RANGES.map((n) => el('button', {
  type: 'button',
  textContent: n === 365 ? '1 year' : `${n} days`,
  className: n === days ? 'selected' : '',
  onclick: (e) => {
    days = n;
    for (const b of $('range').children) b.classList.toggle('selected', b === e.target);
    guarded(loadStats);
  },
})));

// ---- feedback ----

const KINDS = { bug: 'Bug', idea: 'Idea', other: 'Other' };
let shownUnread = null; // the unread count when the list was last drawn

async function loadFeedback() {
  const { messages, unread } = await api('GET', `feedback${$('unreadOnly').checked ? '?unread=1' : ''}`);
  shownUnread = unread;
  const items = messages.map((m) => {
    const toggle = el('button', { textContent: m.read ? 'Mark unread' : 'Mark read' });
    toggle.onclick = () => guarded(async () => {
      await api('POST', 'feedback/read', { id: m.id, read: !m.read });
      await loadFeedback();
      await loadOverview();
    });
    const remove = el('button', { className: 'danger', textContent: 'Delete' });
    remove.onclick = () => {
      if (!confirm(`Delete this message from ${m.name}? This cannot be undone.`)) return;
      guarded(async () => {
        await api('POST', 'feedback/delete', { id: m.id });
        await loadFeedback();
        await loadOverview();
      });
    };
    return el('article', { className: `feedbackItem${m.read ? ' read' : ''}` },
      el('header', {},
        el('strong', { textContent: m.name }),
        el('span', { className: 'kind', textContent: KINDS[m.kind] ?? m.kind }),
        el('span', { textContent: when(m.at) }),
        ...(m.game ? [el('span', { textContent: `on the ${nameOf(m.game)} page` })] : [])),
      el('p', { textContent: m.text }),
      el('div', { className: 'adminActions' }, toggle, remove));
  });
  $('feedbackList').replaceChildren(...(items.length ? items
    : [el('p', { className: 'empty', textContent: $('unreadOnly').checked ? 'No unread feedback.' : 'No feedback yet.' })]));
}
$('unreadOnly').addEventListener('change', () => guarded(loadFeedback));

// ---- game records ----

let records = { game: null, player: '', games: [], more: false };

async function loadRecords(more = false) {
  const game = $('recordsGame').value;
  if (!game) return;
  const player = $('recordsPlayer').value.trim();
  const params = new URLSearchParams({ game });
  if (player) params.set('player', player);
  if (more && records.games.length) params.set('before', records.games[records.games.length - 1].seq);
  const page = await api('GET', `records?${params}`);
  records = { game, player, games: more ? [...records.games, ...page.games] : page.games, more: page.more };
  table('records', ['Ended', 'Players', 'Result', ''], records.games.map((r) => [
    when(r.endedAt),
    r.players.join(' vs '),
    `${r.over?.winner === null || r.over?.winner === undefined ? 'Draw' : `${r.players[r.over.winner] ?? 'Seat ' + r.over.winner} won`} · ${r.over?.reason ?? ''}`,
    el('button', { className: 'danger', textContent: 'Delete', onclick: () => deleteRecord(r) }),
  ]), records.games.length ? '' : 'No games found.');
  if (!records.games.length) $('records').replaceChildren(el('caption', { textContent: 'No games found.' }));
  $('moreRecords').hidden = !records.more;
}

async function deleteRecord(r) {
  if (!confirm(`Delete the game between ${r.players.join(' and ')} that ended ${when(r.endedAt)}? This cannot be undone.`)) return;
  await guarded(async () => {
    await api('POST', 'records/delete', { id: r.id });
    await loadRecords();
  });
}

$('recordsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(() => loadRecords());
});
$('moreRecords').addEventListener('click', () => guarded(() => loadRecords(true)));

start();

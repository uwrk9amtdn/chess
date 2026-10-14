// The site shell: connection, user name, the shared player list, invitations,
// the grid of games and the page that hosts whichever game is being played.
// It knows nothing about any particular game; each one is loaded from
// /games/<id>/client/index.js and driven through the contract in
// games/README.md.

import { play, isMuted, setMuted } from './sounds.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'games.session';
const NAME_KEY = 'games.name';
const WATCH_KEY = 'games.watching';
const THEME_KEY = 'games.theme';
const THEMES = { light: 'Light', dark: 'Dark', sepia: 'Sepia', midnight: 'Midnight' };
const RECONNECT_MS = 1000;
const TOAST_MS = 4000;
let ws = null;
let me = null;
let users = [];
let games = new Map(); // id -> meta, as sent by the server
const clients = new Map(); // id -> the game's browser module
let route = null; // id of the game page that is open, or null for the grid
let match = null; // { game, snapshot }: the match being played, watched or just finished
let liveMatches = []; // every match anyone could watch right now
let following = null; // id of the game whose matches the server keeps us posted on
let previewLimit = Infinity; // with more matches than this, boards are not sent on every move
let past = { games: [], more: false }; // finished matches of the game whose page is open
let rewatch = null; // id of a match to go back to watching after reconnecting
let mounted = null; // { game, view }: the game screen currently on the page
let resuming = false; // the next match message continues an old match
let outgoing = null; // the invitation we sent, if any
let chat = { id: null, messages: [] }; // what was said in the match with that id
const incoming = new Map(); // id -> invitation

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function toast(text) {
  const node = el('div', { className: 'toast', textContent: text });
  $('toasts').append(node);
  setTimeout(() => node.remove(), TOAST_MS);
}

// The name and token live for this tab only, so a reload returns to the same
// seat while a second tab can be a second player.
function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage can be unavailable; the only loss is the automatic rejoin.
  }
}

// The last name used is kept for good, so the next visit signs in with it.
// Only the name: the token stays with the tab, or two tabs would keep taking
// the seat from each other.
function rememberedName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // The name is then asked for again next time.
  }
}

// A spectator's snapshot has no seat: `you` is null.
const spectating = () => Boolean(match && match.snapshot.you === null);
// The match being watched is remembered for this tab, like the session, so a
// reload returns to it.
function rememberWatching(id) {
  try {
    if (id) sessionStorage.setItem(WATCH_KEY, id);
    else sessionStorage.removeItem(WATCH_KEY);
  } catch {
    // Without storage a reload simply returns to the list of games.
  }
}

function recallWatching() {
  try {
    return sessionStorage.getItem(WATCH_KEY);
  } catch {
    return null;
  }
}

const playing = () => Boolean(match && !match.snapshot.over && !spectating());

// ---- connection ----

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  // Messages are handled strictly in order, even though the first one waits
  // for the games' code to load.
  let queue = Promise.resolve();
  ws.onopen = () => {
    $('offline').hidden = true;
    const session = loadSession();
    const name = renaming ?? rememberedName();
    renaming = null;
    if (session) send({ type: 'join', ...session });
    // Should the name be taken, the dialog comes up with it filled in.
    else if (name) send({ type: 'join', name });
    else showNameDialog();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (handlers[msg.type]) queue = queue.then(() => handlers[msg.type](msg)).catch(console.error);
  };
  ws.onclose = () => {
    // Changing the name is a new connection on purpose.
    if (renaming !== null) return connect();
    $('offline').hidden = false;
    setTimeout(connect, RECONNECT_MS);
  };
}

const INVITE_CLOSED = {
  declined: 'declined your invitation',
  expired: 'did not answer',
  unavailable: 'is no longer available',
};

const handlers = {
  async joined(msg) {
    me = msg.name;
    saveSession({ name: msg.name, token: msg.token });
    rememberName(msg.name);
    $('nameDialog').close();
    $('me').textContent = `Signed in as ${me}`;
    $('changeName').hidden = false;
    games = new Map(msg.games.map((g) => [g.id, g]));
    previewLimit = msg.previewLimit;
    following = null;
    await Promise.all(msg.games.map(async (g) => {
      if (!clients.has(g.id)) clients.set(g.id, (await import(`/games/${g.id}/client/index.js`)).default);
    }));
    // After a reconnect the server resends a match that is still running and
    // has dropped every invitation, so start from a clean slate.
    resuming = msg.resumed;
    // A game we were watching has to be asked for again, once the list of
    // matches shows that it is still being played.
    rewatch = recallWatching();
    if (playing() || (spectating() && !match.snapshot.over)) closeMatch();
    outgoing = null;
    incoming.clear();
    applyRoute();
  },
  joinError(msg) {
    me = null;
    $('me').textContent = '';
    $('changeName').hidden = true;
    saveSession(null);
    showNameDialog(msg.message);
  },
  users(msg) {
    users = msg.users;
    render();
  },
  matches(msg) {
    const ended = liveMatches.some((old) => !msg.matches.some((m) => m.id === old.id));
    liveMatches = msg.matches;
    if (rewatch && !match && liveMatches.some((m) => m.id === rewatch)) send({ type: 'watch', id: rewatch });
    else if (rewatch) rememberWatching(null);
    rewatch = null;
    // A match that just ended is now among the past ones.
    if (ended) requestHistory();
    render();
  },
  // One match in progress looks different now.
  preview(msg) {
    const live = liveMatches.find((m) => m.id === msg.id);
    if (!live) return;
    live.preview = msg.preview;
    if (route === live.game && !match) renderLiveMatches();
  },
  history(msg) {
    if (msg.game !== route) return;
    past = { games: msg.before === null ? msg.games : [...past.games, ...msg.games], more: msg.more };
    render();
  },
  invite(msg) {
    incoming.set(msg.id, msg);
    play('notify');
    renderInvites();
  },
  inviteSent(msg) {
    outgoing = msg;
    render();
  },
  inviteClosed(msg) {
    if (outgoing && outgoing.id === msg.id) {
      if (INVITE_CLOSED[msg.reason]) toast(`${outgoing.to} ${INVITE_CLOSED[msg.reason]}.`);
      outgoing = null;
    }
    incoming.delete(msg.id);
    render();
  },
  match(msg) {
    const fresh = !match || match.snapshot.id !== msg.snapshot.id;
    if (fresh && !resuming && !msg.snapshot.over && msg.snapshot.you !== null) play('start');
    if (fresh) showPlayers(false);
    resuming = false;
    match = { game: msg.game, snapshot: msg.snapshot };
    rememberWatching(spectating() && !msg.snapshot.over ? msg.snapshot.id : null);
    // A match takes over the page, wherever the player was.
    if (route !== msg.game) {
      route = msg.game;
      location.hash = `#/${msg.game}`;
    }
    if (mounted && mounted.game !== match.game) unmount();
    const opened = !mounted;
    if (opened) mounted = { game: match.game, view: clients.get(match.game).mount($('matchHost'), ctx) };
    mounted.view.update(match.snapshot);
    if (chat.id !== msg.snapshot.id) chat = { id: msg.snapshot.id, messages: [] };
    if (fresh || opened) showChat();
    render();
  },
  chat(msg) {
    if (chat.id !== msg.id) chat = { id: msg.id, messages: [] };
    chat.messages.push({ from: msg.from, text: msg.text });
    showChat();
  },
  // Everything said so far, sent when we come back to a match.
  chatLog(msg) {
    chat = { id: msg.id, messages: msg.messages };
    showChat();
  },
  error(msg) {
    toast(msg.message);
    // Lets the game undo anything it showed before the server refused it.
    if (mounted) mounted.view.update(match.snapshot);
  },
};

// Hands the conversation to the game on screen, if it shows one.
function showChat() {
  if (mounted && match && match.snapshot.id === chat.id) mounted.view.chat?.(chat.messages);
}

// What a game's screen gets from the platform.
const ctx = {
  send: (action) => send({ ...action, type: 'action' }),
  sendChat: (text) => send({ type: 'chat', text }),
  toolbar: $('toolbar'),
  play,
  toast,
};

function unmount() {
  mounted.view.destroy();
  mounted = null;
}

function closeMatch() {
  if (spectating() && !match.snapshot.over) send({ type: 'unwatch' });
  rememberWatching(null);
  match = null;
  if (mounted) unmount();
}

// ---- routing: "#/" is the grid, "#/<game id>" is that game's page ----

function applyRoute() {
  showPlayers(false);
  const id = location.hash.replace(/^#\/?/, '');
  const next = games.has(id) ? id : null;
  // A match in progress cannot be left by navigating; a finished one is put away.
  if (playing() && next !== match.game) {
    location.hash = `#/${match.game}`;
    return;
  }
  if (match && next !== match.game) closeMatch();
  if (next !== route) past = { games: [], more: false };
  route = next;
  requestHistory();
  render();
}
window.addEventListener('hashchange', applyRoute);

function render() {
  syncFollowing();
  $('home').hidden = route !== null;
  $('gamePage').hidden = route === null;
  renderGrid();
  renderUsers();
  renderInvites();
  if (route === null) return;
  const meta = games.get(route);
  $('gameTitle').textContent = meta.name;
  $('gameDescription').textContent = meta.description;
  $('gameHint').hidden = Boolean(match);
  $('playBot').hidden = !clients.get(route).botForm;
  if (!match) {
    renderLiveMatches();
    renderPastMatches();
  }
  $('backLink').hidden = playing();
  // Rematch is offered once a match is over; assumes the two-player games the
  // lobby seats today. A spectator can leave at any time.
  const over = Boolean(match && match.snapshot.over);
  $('afterGame').hidden = !over && !spectating();
  $('rematch').hidden = spectating();
  $('closeMatch').textContent = spectating() && !over ? 'Stop watching' : 'Close';
  if (over && !spectating()) {
    const rival = opponent();
    const free = users.some((u) => u.name === rival && u.status === 'idle');
    // A bot is always free for another game.
    $('rematch').disabled = botOf(match.snapshot) ? false : !free || Boolean(outgoing);
  }
}

const opponent = () => match.snapshot.players.find((_, seat) => seat !== match.snapshot.you);
// What a game says about the bot in a match against one (see `bots` in
// games/README.md), or undefined in a match between people.
const botOf = (snapshot) => snapshot.bots?.find(Boolean);

$('rematch').addEventListener('click', () => {
  const { options, you } = match.snapshot;
  const bot = botOf(match.snapshot);
  if (bot) send({ type: 'bot', game: match.game, options, bot, seat: you });
  else send({ type: 'invite', to: opponent(), game: match.game, options });
});
$('closeMatch').addEventListener('click', () => {
  closeMatch();
  render();
});

// One match in a grid: the last seat's name, the game's own preview, the
// first seat's name (the side a spectator sits on), then the given lines.
function matchCard(m, lines, onclick) {
  const client = clients.get(route);
  const picture = el('div', { className: 'matchPreview' });
  if (m.preview && client.preview) client.preview(picture, m.preview);
  const [first, ...others] = m.players;
  return el('button', { className: 'matchCard', onclick },
    el('span', { className: 'matchName', textContent: others.join(', ') }),
    picture,
    el('span', { className: 'matchName', textContent: first }),
    ...lines);
}

const liveHere = () => liveMatches.filter((m) => m.game === route);

function renderLiveMatches() {
  const live = liveHere();
  const cards = live.map((m) => matchCard(m, [
    el('span', { className: 'matchResult matchLive', textContent: 'Playing now' }),
    el('span', { className: 'matchDetail', textContent: clients.get(route).describeOptions(m.options) }),
  ], () => send({ type: 'watch', id: m.id })));
  $('noLiveGames').hidden = cards.length > 0;
  $('liveGames').replaceChildren(...cards);
  $('livePaused').hidden = live.length <= previewLimit;
  $('livePaused').textContent =
    `With more than ${previewLimit} games the boards are only refreshed when a game starts or ends.`;
}

// While a game's list of matches is on screen we follow that game, and the
// server sends each board as it changes.
function syncFollowing() {
  const wanted = route && !match ? route : null;
  if (wanted === following) return;
  following = wanted;
  send(wanted ? { type: 'follow', game: wanted } : { type: 'unfollow' });
}

// Asks for the finished matches of the open game: the newest ones, or with
// `more` the ones after those already listed.
function requestHistory(more = false) {
  if (!route) return;
  send({
    type: 'history',
    game: route,
    player: $('onlyMine').checked ? me : undefined,
    before: more && past.games.length ? past.games[past.games.length - 1].seq : undefined,
  });
}
$('onlyMine').addEventListener('change', () => requestHistory());
$('morePast').addEventListener('click', () => requestHistory(true));

const formatDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

function renderPastMatches() {
  const client = clients.get(route);
  const cards = past.games.map((m) => matchCard(m, [
    el('span', { className: 'matchResult', textContent: client.describeResult?.({ ...m, game: route }) ?? '' }),
    el('span', { className: 'matchDetail', textContent: `${client.describeOptions(m.options)} · ${formatDate(m.endedAt)}` }),
  ], () => send({ type: 'review', id: m.id })));
  $('noPastGames').hidden = cards.length > 0;
  $('pastGames').replaceChildren(...cards);
  $('morePast').hidden = !past.more;
}

function renderGrid() {
  $('gameGrid').replaceChildren(...[...games.values()].map((g) => {
    const active = users.filter((u) => u.game === g.id).length;
    return el('a', { className: 'gameCard', href: `#/${g.id}` },
      el('span', { className: 'gameIcon', textContent: g.icon || g.name[0] }),
      el('strong', { textContent: g.name }),
      el('span', { className: 'gameAbout', textContent: g.description }),
      el('span', { className: 'gameMeta', textContent: `${g.players} players · ${active} playing now` }));
  }));
}

// ---- name ----

// The name a change of name is waiting to sign in with, or null.
let renaming = null;

// With `changing`, the player is signed in already and may think better of it.
function showNameDialog(error = '', changing = false) {
  $('nameError').textContent = error;
  $('nameCancel').hidden = !changing;
  if (!$('nameInput').value) $('nameInput').value = me ?? rememberedName();
  if (!$('nameDialog').open) $('nameDialog').showModal();
  $('nameInput').focus();
}

$('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('nameInput').value.trim();
  if (me === null) return send({ type: 'join', name });
  $('nameDialog').close();
  if (name === me) return;
  // The server has no renaming: leave and come back under the new name.
  renaming = name;
  saveSession(null);
  ws.close();
});
// Signed out, a name is required, so Escape must not dismiss the dialog.
$('nameDialog').addEventListener('cancel', (e) => {
  if (me === null) e.preventDefault();
});
$('nameCancel').addEventListener('click', () => $('nameDialog').close());
$('changeName').addEventListener('click', () => {
  // Leaving would give up the game.
  if (playing()) return toast('Finish your game before changing your name.');
  $('nameInput').value = me;
  showNameDialog('', true);
});

// ---- players and invitations ----

function renderUsers() {
  const sorted = [...users].sort((a, b) => (b.name === me) - (a.name === me) || a.name.localeCompare(b.name));
  $('userCount').textContent = $('userCountTop').textContent = users.length;
  $('users').replaceChildren(...sorted.map((u) => {
    let status = u.game && games.has(u.game) ? `${u.status} · ${games.get(u.game).name}` : u.status;
    if (u.name === me) status = `you · ${status}`;
    const li = el('li', {},
      el('span', { className: `dot ${u.status}` }),
      el('span', { className: 'userName', textContent: u.name }),
      el('span', { className: `userStatus ${u.status}`, textContent: status }));
    // Invitations are for the game whose page is open.
    if (route && u.name !== me && u.status === 'idle' && !playing() && !outgoing) {
      li.append(el('button', { textContent: 'Invite', onclick: () => openInvite(u.name) }));
    }
    return li;
  }));
}

// On a narrow screen the sidebar is put away: a button in the bar at the top
// opens it over the whole page.
function showPlayers(open) {
  document.body.classList.toggle('playersOpen', open);
}
$('openPlayers').addEventListener('click', () => showPlayers(true));
$('closePlayers').addEventListener('click', () => showPlayers(false));

function openInvite(name) {
  showPlayers(false);
  const game = route;
  $('inviteTitle').textContent = `Challenge ${name} to ${games.get(game).name}`;
  $('inviteForm').replaceChildren();
  clients.get(game).inviteForm($('inviteForm'), (options) => {
    send({ type: 'invite', to: name, game, options });
    $('inviteDialog').close();
  });
  $('inviteDialog').showModal();
}
// A game against the computer is set up in the same dialog and starts at once.
$('playBot').addEventListener('click', () => {
  const game = route;
  $('inviteTitle').textContent = `Play ${games.get(game).name} against the computer`;
  $('inviteForm').replaceChildren();
  clients.get(game).botForm($('inviteForm'), (request) => {
    send({ type: 'bot', game, ...request });
    $('inviteDialog').close();
  });
  $('inviteDialog').showModal();
});
$('inviteCancel').addEventListener('click', () => $('inviteDialog').close());

// "Chess (3+1)"
function describeInvite({ game, options }) {
  return `${games.get(game).name} (${clients.get(game).describeOptions(options)})`;
}

function renderInvites() {
  const cards = [];
  if (outgoing) {
    cards.push(el('div', { className: 'invite' },
      el('p', { textContent: `Waiting for ${outgoing.to}: ${describeInvite(outgoing)}…` }),
      el('button', { textContent: 'Cancel', onclick: () => send({ type: 'cancel', id: outgoing.id }) })));
  }
  for (const invite of incoming.values()) {
    cards.push(el('div', { className: 'invite' },
      el('p', {}, el('strong', { textContent: invite.from }), ` challenges you to ${describeInvite(invite)}.`),
      el('button', { className: 'primary', textContent: 'Accept', onclick: () => send({ type: 'accept', id: invite.id }) }),
      el('button', { textContent: 'Decline', onclick: () => send({ type: 'decline', id: invite.id }) })));
  }
  $('invites').replaceChildren(...cards);
}

// ---- sound ----

function renderSoundToggle() {
  $('soundToggle').textContent = isMuted() ? 'Sound: off' : 'Sound: on';
}
$('soundToggle').addEventListener('click', () => {
  setMuted(!isMuted());
  renderSoundToggle();
  play('move');
});
renderSoundToggle();

// ---- theme ----

// The site's colours; the page already wears the saved theme (see index.html).
function currentTheme() {
  const theme = document.documentElement.dataset.theme;
  return theme in THEMES ? theme : 'light';
}

// The phone's status bar takes the colour of the bar along the top.
function matchStatusBar() {
  const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
  document.querySelector('meta[name="theme-color"]').content = surface;
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  matchStatusBar();
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // The choice then lasts until the page closes.
  }
}

function renderSiteThemes() {
  $('siteThemes').replaceChildren(...Object.entries(THEMES).map(([id, name]) => {
    const selected = id === currentTheme();
    // A sample of the theme in its own colours.
    const sample = el('span', { className: 'themeSample' }, el('span'), el('span'));
    sample.dataset.theme = id;
    return el('button', {
      type: 'button',
      className: selected ? 'selected' : '',
      ariaPressed: String(selected),
      onclick: () => {
        setTheme(id);
        renderSiteThemes();
      },
    }, sample, name);
  }));
}

$('themeOpen').addEventListener('click', () => {
  renderSiteThemes();
  // Games add their own choices, drawn afresh each time the menu opens.
  const sections = [];
  for (const client of clients.values()) {
    if (!client.settings) continue;
    const section = el('div');
    client.settings(section);
    sections.push(section);
  }
  $('gameThemes').replaceChildren(...sections);
  $('themeDialog').showModal();
});
$('themeDone').addEventListener('click', () => $('themeDialog').close());
matchStatusBar();

// Lets the site be installed as an app; see sw.js.
navigator.serviceWorker?.register('/sw.js').catch(console.error);

connect();

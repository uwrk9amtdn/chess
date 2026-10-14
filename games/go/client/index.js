// Go in the browser: the options in the invitation dialog and the game
// screen. All game state comes from the server as snapshots; this file only
// draws them and sends the player's intent. See games/README.md.

import { createGame, applyMove, score, SIZES, MAX_HANDICAP, BLACK } from '../shared/rules.js';
import { initialClock, spend, timeLeft } from '../shared/clock.js';
import { BOT_LEVELS } from '../shared/mcts.js';
import { createBoard, drawThumbnail } from './board.js';
import { settings } from './theme.js';
import { createBot } from './bot/index.js';

const LOW_TIME_MS = 10_000;
// A step button that is held down starts repeating after the first of these,
// once every second one.
const HOLD_DELAY_MS = 400;
const HOLD_REPEAT_MS = 90;
const PRESETS = [
  { clock: 'fischer', minutes: 3, increment: 2 },
  { clock: 'fischer', minutes: 5, increment: 5 },
  { clock: 'fischer', minutes: 10, increment: 10 },
  { clock: 'fischer', minutes: 20, increment: 20 },
  { clock: 'byoyomi', minutes: 5, periods: 3, period: 20 },
  { clock: 'byoyomi', minutes: 10, periods: 5, period: 30 },
  { clock: 'byoyomi', minutes: 20, periods: 5, period: 30 },
  { clock: 'byoyomi', minutes: 30, periods: 5, period: 60 },
];
const CLOCKS = { fischer: 'Fischer', byoyomi: 'Byo-yomi' };
const SETUP_KEY = 'go.setup';
const CHAT_PHRASES = { GG: 'Good game', WP: 'Well played', TY: 'Thank you', GTG: "I've got to go", BYE: 'Bye!' };
const CHAT_MAX_LENGTH = 140;
const CHAT_KEY = 'go.chat';
const COLOURS = ['Black', 'White'];
// On a narrow screen the board shrinks so the rest fits under it, but to no
// less than this part of the width; past that the page scrolls.
const MIN_FIT = 0.7;
const NARROW = matchMedia('(max-width: 860px)');

const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = new URL('./go.css', import.meta.url);
document.head.append(stylesheet);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// "10+5" for Fischer, "10m 5×30s" for byo-yomi.
function formatTimeControl({ clock, minutes, increment, periods, period }) {
  if (clock === 'byoyomi') return `${minutes ? `${minutes}m ` : ''}${periods}×${period}s`;
  return `${minutes}+${increment}`;
}

const pad = (n) => String(n).padStart(2, '0');

function formatClock(ms) {
  if (ms < LOW_TIME_MS) {
    const tenths = Math.floor(ms / 100);
    return `00:0${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  const seconds = Math.ceil(ms / 1000);
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

const capitalise = (text) => text[0].toUpperCase() + text.slice(1);

// The chat can be switched off; the choice is kept for next time.
function chatEnabled() {
  try {
    return localStorage.getItem(CHAT_KEY) !== 'off';
  } catch {
    return true;
  }
}

function setChatEnabled(on) {
  try {
    localStorage.setItem(CHAT_KEY, on ? 'on' : 'off');
  } catch {
    // Storage can be unavailable; the choice then lasts until the page closes.
  }
}

function icon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}
const NAV_ICONS = {
  first: 'M6 5h2v14H6zM20 5v14l-10-7z',
  prev: 'M17 5v14L7 12z',
  next: 'M7 5v14l10-7z',
  last: 'M16 5h2v14h-2zM4 5v14l10-7z',
};

// "10+5 • 19×19", with the handicap where there is one.
function describeOptions(options) {
  const { size, handicap } = options;
  return `${formatTimeControl(options)} • ${size}×${size}${handicap ? ` • ${handicap} stones` : ''}`;
}

// The values the sliders step through.
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const MINUTES = [...range(1, 20), 25, 30, 35, 40, 45, 60, 75, 90];
const MAIN_MINUTES = [0, ...MINUTES];
const INCREMENTS = [...range(0, 20), 25, 30, 40, 45, 60];
const PERIODS = range(1, 10);
const PERIOD_SECONDS = [5, 10, 15, 20, 30, 40, 45, 60, 90, 120];
const HANDICAPS = [0, ...range(2, MAX_HANDICAP)];

// The side a player may ask for against a bot, and the seat that is.
const SIDES = { black: 0, random: null, white: 1 };

// What was last sent from the game setup is offered again, and so are the
// bot's level and the side played against it.
function rememberedSetup() {
  const setup = {
    size: 19, handicap: 0, clock: 'byoyomi', minutes: 10, increment: 10, periods: 5, period: 30, level: 3, side: 'random',
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SETUP_KEY)) || {};
    if (SIZES.includes(saved.size)) setup.size = saved.size;
    if (HANDICAPS.includes(saved.handicap)) setup.handicap = saved.handicap;
    if (Object.hasOwn(CLOCKS, saved.clock)) setup.clock = saved.clock;
    if (MAIN_MINUTES.includes(saved.minutes)) setup.minutes = saved.minutes;
    if (INCREMENTS.includes(saved.increment)) setup.increment = saved.increment;
    if (PERIODS.includes(saved.periods)) setup.periods = saved.periods;
    if (PERIOD_SECONDS.includes(saved.period)) setup.period = saved.period;
    if (Number.isInteger(saved.level) && saved.level >= 1 && saved.level <= BOT_LEVELS) setup.level = saved.level;
    if (Object.hasOwn(SIDES, saved.side)) setup.side = saved.side;
  } catch {
    // Nothing usable was saved.
  }
  // Fischer needs some main time.
  if (setup.clock === 'fischer' && !setup.minutes) setup.minutes = 1;
  return setup;
}

function saveSetup(setup) {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
  } catch {
    // Storage can be unavailable; the setup is then not remembered.
  }
}

// The options of a game from the setup: only the fields its clock uses.
function optionsOf(setup) {
  const { size, handicap, clock, minutes } = setup;
  return clock === 'fischer'
    ? { size, handicap, clock, minutes, increment: setup.increment }
    : { size, handicap, clock, minutes, periods: setup.periods, period: setup.period };
}

// A row of buttons of which one is chosen.
function segmented(className, choices, current, pick) {
  const row = el('div', { className });
  const render = (value) => {
    [...row.children].forEach((button, i) => button.classList.toggle('selected', choices[i][0] === value));
  };
  row.append(...choices.map(([value, label]) => el('button', {
    type: 'button',
    textContent: label,
    onclick: () => {
      pick(value);
      render(value);
    },
  })));
  render(current);
  return row;
}

// First the board size and a grid of time controls: clicking one sends an
// invitation to an even game. "Custom" leads to the game setup, where the
// handicap and any time control can be chosen.
function inviteForm(container, submit) {
  setupForm(container, submit, false);
}

// The same for a game against a bot, with its level and the side to play
// above both. Submits { options, bot, seat }, which is what the lobby's "bot"
// message takes.
function botForm(container, submit) {
  setupForm(container, submit, true);
}

function setupForm(container, submit, bot) {
  const setup = rememberedSetup();
  const done = (options) => {
    saveSetup(setup);
    if (!bot) return submit(options);
    submit({ options, bot: { level: setup.level }, seat: SIDES[setup.side] });
  };

  const sizes = segmented('goSizes', SIZES.map((s) => [s, `${s}×${s}`]), setup.size, (size) => {
    setup.size = size;
  });

  const tiles = PRESETS.map((preset) => el('button', {
    type: 'button',
    className: 'goTimeTile',
    onclick: () => {
      Object.assign(setup, preset);
      done({ ...optionsOf({ ...setup, handicap: 0 }) });
    },
  }, el('strong', { textContent: formatTimeControl(preset) }), el('span', { textContent: CLOCKS[preset.clock] })));
  const grid = el('div', { className: 'goTimes' }, ...tiles,
    el('button', { type: 'button', className: 'goTimeTile', onclick: () => show(true) },
      el('span', { textContent: 'Custom' })));

  // A labelled slider over a list of values, with the value in a badge.
  function slider(label, values, key, format = (v) => v) {
    const input = el('input', { type: 'range', min: 0, max: values.length - 1, step: 1 });
    const badge = el('strong');
    const render = () => {
      input.value = Math.max(0, values.indexOf(setup[key]));
      badge.textContent = format(setup[key]);
    };
    input.oninput = () => {
      setup[key] = values[input.value];
      render();
    };
    return { node: el('label', {}, el('span', {}, `${label} `, badge), input), render };
  }
  const handicap = slider('Handicap', HANDICAPS, 'handicap', (h) => (h ? `${h} stones` : 'None'));
  const fischerMinutes = slider('Minutes per side', MINUTES, 'minutes');
  const increment = slider('Increment in seconds', INCREMENTS, 'increment');
  const mainMinutes = slider('Main time in minutes', MAIN_MINUTES, 'minutes');
  const periods = slider('Periods', PERIODS, 'periods');
  const period = slider('Seconds per period', PERIOD_SECONDS, 'period');
  const sliders = [handicap, fischerMinutes, increment, mainMinutes, periods, period];
  const fischerBox = el('div', { className: 'goSliders' }, fischerMinutes.node, increment.node);
  const byoBox = el('div', { className: 'goSliders' }, mainMinutes.node, periods.node, period.node);
  function renderClock() {
    if (setup.clock === 'fischer' && !setup.minutes) setup.minutes = 1;
    fischerBox.hidden = setup.clock !== 'fischer';
    byoBox.hidden = setup.clock !== 'byoyomi';
    for (const s of sliders) s.render();
  }
  const clocks = segmented('goChoice', Object.entries(CLOCKS), setup.clock, (clock) => {
    setup.clock = clock;
    renderClock();
  });

  const form = el('div', { className: 'goSetup', hidden: true },
    el('div', { className: 'goSliders' }, handicap.node),
    clocks, fischerBox, byoBox,
    el('div', { className: 'goSetupActions' },
      el('button', { type: 'button', textContent: '← Back', onclick: () => show(false) }),
      el('button', {
        type: 'button',
        className: 'primary',
        textContent: bot ? 'Play' : 'Send invitation',
        onclick: () => done(optionsOf(setup)),
      })));

  // The opponent, for a game against a bot: how strong, and which side we take.
  const level = el('input', { type: 'range', min: 1, max: BOT_LEVELS, step: 1, value: setup.level });
  const levelBadge = el('strong', { textContent: setup.level });
  level.oninput = () => {
    setup.level = Number(level.value);
    levelBadge.textContent = setup.level;
  };
  const sides = segmented('goChoice', Object.keys(SIDES).map((side) => [side, capitalise(side)]), setup.side, (side) => {
    setup.side = side;
  });
  const opponent = el('div', { className: 'goOpponent', hidden: !bot },
    el('label', {}, el('span', {}, 'Level ', levelBadge), level), sides);

  function show(custom) {
    grid.hidden = custom;
    form.hidden = !custom;
  }
  renderClock();
  container.append(opponent, sizes, grid, form);
}

// How each ending reads, given the colour that lost: "White resigned".
const ENDINGS = {
  score: () => 'Counted',
  scoreTimeout: () => 'Counted by the server',
  resign: (loser) => `${loser} resigned`,
  timeout: (loser) => `${loser} ran out of time`,
  abandoned: (loser) => `${loser} left the game`,
};
// The letter after "B+" or "W+" for a game that was not counted.
const SHORT = { resign: 'R', timeout: 'T', abandoned: 'F' };

// { score: 'B+3.5', how: 'Counted', text: 'Counted • Black is victorious' }
function resultOf({ reason, winner, black, white }) {
  const how = ENDINGS[reason](COLOURS[1 - winner]);
  const margin = black === undefined ? SHORT[reason] : Math.abs(black - white);
  return { score: `${COLOURS[winner][0]}+${margin}`, how, text: `${how} • ${COLOURS[winner]} is victorious` };
}

// "B+3.5 • Counted", for lists of finished games.
function describeResult({ over }) {
  const { score: result, how } = resultOf(over);
  return `${result} • ${how}`;
}

const counted = (over) => over && over.black !== undefined;

function mount(container, ctx) {
  // What is shown for one player beside the board: top is the opponent. On a
  // narrow screen the stylesheet puts each player's on a line above or below
  // the board, which is what `where` is for.
  const side = (where) => ({
    captures: el('div', { className: `goCaptures ${where}` }),
    clock: el('div', { className: `goClock ${where}` }, el('span', { className: 'time' }), el('span', { className: 'periods' })),
    bar: el('div', { className: `goBar ${where}` }, el('span')),
    player: el('div', { className: `goPlayer ${where}` },
      el('span', { className: 'dot' }), el('span', { className: 'stone' }), el('span', { className: 'name' })),
  });
  const top = side('top');
  const bottom = side('bottom');
  const boardEl = el('div', { className: 'goBoard' });
  const nav = Object.fromEntries(Object.entries(NAV_ICONS).map(([name, path]) => {
    const button = el('button', { type: 'button', title: `${capitalise(name)} move` }, icon(path));
    return [name, button];
  }));
  const movesEl = el('div', { className: 'goMoves' });
  const statusEl = el('div', { className: 'goStatus' });
  const actionsEl = el('div', { className: 'goActions' });

  const timeEl = el('div', { className: 'goTime' });
  const rulesEl = el('div', { className: 'goRules' });
  const namesEl = el('div', { className: 'goNames' });
  const watchersEl = el('div', { className: 'goWatchers' });
  const resultEl = el('div', { className: 'goResult' });

  const chatToggle = el('input', { type: 'checkbox', checked: chatEnabled(), title: 'Show the chat' });
  const chatList = el('ul', { className: 'goChatLog' });
  const chatInput = el('input', {
    maxLength: CHAT_MAX_LENGTH, autocomplete: 'off', placeholder: 'Please be nice in the chat!',
  });
  const chatForm = el('form', {}, chatInput);
  const chatQuick = el('div', { className: 'goChatQuick' },
    ...Object.entries(CHAT_PHRASES).map(([short, phrase]) => el('button', {
      type: 'button',
      textContent: short,
      title: phrase,
      onclick: () => ctx.sendChat(phrase),
    })));
  const chatBody = el('div', { className: 'goChatBody' }, chatList, chatForm, chatQuick);
  // On a narrow screen the chat is put away: a button in the platform's bar
  // opens it over the whole page, and shows when something new was said.
  const chatOpen = el('button', { type: 'button', className: 'goChatOpen', textContent: 'Chat', hidden: true });
  const chatClose = el('button', { type: 'button', className: 'goChatClose', textContent: 'Close' });
  const chatCard = el('div', { className: 'goCard goChat' },
    el('div', { className: 'goChatHead' }, el('label', {}, 'Chat room', chatToggle), chatClose), chatBody);
  ctx.toolbar?.append(chatOpen);

  const table = el('div', { className: 'goTable' }, boardEl);
  const root = el('div', { className: 'go' });
  root.append(
    el('div', { className: 'goSide' },
      el('div', { className: 'goCard goInfo' }, timeEl, rulesEl, namesEl, watchersEl, resultEl),
      chatCard),
    table,
    el('div', { className: 'goControls' },
      top.captures, top.clock,
      el('div', { className: 'goCard goPanel' },
        top.bar, top.player,
        el('div', { className: 'goNav' }, nav.first, nav.prev, nav.next, nav.last),
        movesEl, statusEl, actionsEl,
        bottom.player, bottom.bar),
      bottom.clock, bottom.captures));
  container.replaceChildren(root);

  let game = null; // latest snapshot from the server
  let gameAt = 0; // performance.now() when it arrived, for ticking the clock
  let lowTimeWarned = null; // id of the game we already beeped for
  let viewPly = null; // the earlier position being looked at, or null for the latest
  let replay = { key: null, states: [] }; // the position after each move of one game
  let shown = { id: null, ply: 0 }; // what the board showed last
  let chatMessages = [];
  // Plays the other seat when this is a game against a bot.
  const bot = createBot(ctx);

  const board = createBoard(boardEl, {
    onPlay: (point) => ctx.send({ action: 'move', point }),
    onToggle: (point) => ctx.send({ action: 'toggleDead', point }),
  });

  // Plays the sound of the move that led to the position after `ply` moves.
  function playMove(states, ply) {
    if (game.played[ply - 1].pass) return;
    const taken = (s) => s.captures[0] + s.captures[1];
    ctx.play(taken(states[ply]) > taken(states[ply - 1]) ? 'capture' : 'move');
  }

  // Plays the sounds for whatever changed between two snapshots of one game.
  function announce(prev, next) {
    const same = Boolean(prev && prev.id === next.id);
    const mine = (g) => g.you !== null;
    if (same && next.played.length > prev.played.length) {
      const move = next.played[next.played.length - 1];
      // The other player passing is worth noticing.
      if (move.pass) {
        if (mine(next) && next.turn === next.you) ctx.play('notify');
      } else ctx.play(next.captures[0] + next.captures[1] > prev.captures[0] + prev.captures[1] ? 'capture' : 'move');
    }
    if (same && next.scoring && !prev.scoring && !next.over) ctx.play('notify', 0.2);
    if (same && next.over && !prev.over) ctx.play('end', 0.3);
    const offered = (g) => mine(g) && g.takebackOffer !== null && g.takebackOffer !== g.you;
    if (offered(next) && !(same && offered(prev))) ctx.play('notify');
  }

  // Our own seat is at the bottom of the panel; a spectator sits with Black.
  // The board is the same way up for everyone.
  const watching = () => game.you === null;
  const bottomSeat = () => game.you ?? BLACK;
  const topSeat = () => 1 - bottomSeat();

  // The server sends the moves; replaying them gives every position of the
  // game, which is what lets the player step back through it.
  function positions() {
    // After a takeback the moves are no longer the ones replayed so far.
    const key = `${game.id}:${game.takebacks}`;
    if (replay.key !== key) replay = { key, states: [createGame(game.options.size, game.options.handicap)] };
    const { states } = replay;
    for (let i = states.length - 1; i < game.played.length; i++) states.push(applyMove(states[i], game.played[i]));
    return states;
  }

  // Looks at the position after `ply` moves without changing the game.
  function go(ply) {
    const total = game.played.length;
    const clamped = Math.max(0, Math.min(total, ply));
    // Stepping through the game sounds like the moves being played.
    if (clamped && clamped !== (viewPly ?? total)) playMove(replay.states, clamped);
    viewPly = clamped === total ? null : clamped;
    render();
  }
  nav.first.onclick = () => go(0);
  nav.last.onclick = () => go(game.played.length);

  // One step back or forward, and more of them for as long as the button is
  // held down.
  let holdTimer = null;
  const release = () => clearTimeout(holdTimer);
  for (const [button, by] of [[nav.prev, -1], [nav.next, 1]]) {
    const step = () => go((viewPly ?? game.played.length) + by);
    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      release();
      step();
      const again = () => {
        if (button.disabled) return;
        step();
        holdTimer = setTimeout(again, HOLD_REPEAT_MS);
      };
      holdTimer = setTimeout(again, HOLD_DELAY_MS);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, release);
    // A long press must not bring up the browser's menu instead.
    button.addEventListener('contextmenu', (e) => e.preventDefault());
    // The pointer has stepped already; this is for the keyboard.
    button.addEventListener('click', (e) => {
      if (e.detail === 0) step();
    });
  }

  function onKey(e) {
    if (!game || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, dialog')) return;
    const total = game.played.length;
    const ply = viewPly ?? total;
    const target = { ArrowLeft: ply - 1, ArrowRight: ply + 1, ArrowUp: 0, ArrowDown: total }[e.key];
    if (target === undefined) return;
    e.preventDefault();
    go(target);
  }
  document.addEventListener('keydown', onKey);

  // The stones marked dead and who owns what, while counting and at the end
  // of a counted game; null otherwise.
  function counting(state, ply) {
    if (ply !== game.played.length) return null;
    const dead = game.scoring ? game.scoring.dead : counted(game.over) ? game.dead : null;
    if (!dead) return null;
    return { dead: new Set(dead), ...score(state, dead, game.komi) };
  }

  const scoringLeft = el('span', { className: 'goCountdown' });

  function statusText(count) {
    if (game.takebackOffer !== null && game.takebackOffer !== game.you) {
      return `${game.players[game.takebackOffer]} proposes a takeback`;
    }
    const mover = game.turn;
    let text = watching() ? `${COLOURS[mover]} to play` : mover === game.you ? 'Your move' : `Waiting for ${game.players[mover]}`;
    if (game.passes) text = `${game.players[1 - mover]} passed • ${text}`;
    if (!count) return text;
    const { accepted } = game.scoring;
    const agreedBy = accepted.map((yes, seat) => (yes ? game.players[seat] : null)).filter(Boolean);
    return el('span', {},
      el('strong', { textContent: `Black ${count.black} • White ${count.white}` }),
      watching() ? 'The players are marking dead stones' : 'Click a chain to mark it dead or alive, then accept',
      agreedBy.length ? `Accepted by ${agreedBy.join(' and ')}` : '',
      scoringLeft);
  }

  function render() {
    const states = positions();
    const total = game.played.length;
    const ply = viewPly ?? total;
    const state = states[ply];
    const live = !game.over;
    const count = counting(state, ply);

    let mode = 'none';
    if (live && ply === total && !watching()) {
      if (game.scoring) mode = 'mark';
      else if (game.turn === game.you) mode = 'play';
    }
    const last = ply ? game.played[ply - 1] : null;
    board.update({
      state,
      seat: game.you ?? BLACK,
      lastMove: last && !last.pass ? last.point : null,
      mode,
      owner: count?.owner ?? null,
      dead: count?.dead ?? null,
      // One step forward or back fades the stones in and out; a longer jump
      // just shows the position.
      animate: shown.id === game.id && Math.abs(ply - shown.ply) <= 1,
    });
    shown = { id: game.id, ply };

    for (const [where, seat] of [[top, topSeat()], [bottom, bottomSeat()]]) {
      // Who is still connected says nothing once the game is over.
      const dot = where.player.querySelector('.dot');
      dot.className = `dot ${game.connected[seat] ? 'online' : 'offline'}`;
      dot.hidden = !live;
      where.player.querySelector('.stone').className = `stone ${seat === BLACK ? 'b' : 'w'}`;
      where.player.querySelector('.name').textContent = game.players[seat];
      where.clock.classList.toggle('active', live && game.running === seat);
      where.clock.dataset.seat = seat;
      // The stones this player has taken, which are the other colour.
      const taken = state.captures[seat];
      where.captures.replaceChildren(...(taken ? [el('span', { className: `stone ${seat === BLACK ? 'w' : 'b'}` }), `${taken} captured`] : []));
    }

    const { size, handicap } = game.options;
    timeEl.replaceChildren(el('span', { className: 'goIcon', textContent: '◉︎' }),
      `${formatTimeControl(game.options)} • ${CLOCKS[game.options.clock]} • ${size}×${size}`);
    rulesEl.textContent = `${handicap ? `${handicap} handicap stones • ` : ''}Komi ${game.komi} • Area scoring`;
    namesEl.replaceChildren(...game.players.map((name, seat) => el('div', {},
      el('span', { className: `stone ${seat === BLACK ? 'b' : 'w'}` }), name)));
    watchersEl.hidden = !game.spectators || !live;
    watchersEl.textContent = `${game.spectators} watching`;
    // A bot has nothing to say.
    chatCard.hidden = chatOpen.hidden = watching() || Boolean(game.bots?.some(Boolean));
    const result = game.over && resultOf(game.over);
    resultEl.hidden = !result;
    resultEl.textContent = result ? result.text : '';
    if (result) {
      const counts = counted(game.over) ? [el('span', { textContent: `Black ${game.over.black} • White ${game.over.white}` })] : [];
      statusEl.replaceChildren(el('strong', { textContent: result.score }), el('em', { textContent: result.text }), ...counts);
    } else statusEl.replaceChildren(statusText(game.scoring && count));
    statusEl.classList.toggle('over', !live);
    statusEl.classList.toggle('counting', Boolean(live && game.scoring));

    // Two moves a row, numbered by the first of them.
    const cells = [];
    game.moves.forEach((name, i) => {
      if (i % 2 === 0) cells.push(el('span', { className: 'index', textContent: i + 1 }));
      cells.push(el('button', {
        type: 'button',
        className: `${i + 1 === ply ? 'active' : ''}${name === 'Pass' ? ' pass' : ''}`,
        textContent: name,
        onclick: () => go(i + 1),
      }));
    });
    movesEl.replaceChildren(...cells);
    // Scroll only as far as needed to keep the move being shown in sight:
    // down the list, or along it where a narrow screen has it in one row.
    const active = movesEl.querySelector('.active');
    if (!active) movesEl.scrollTop = movesEl.scrollLeft = 0;
    else {
      const below = active.offsetTop + active.offsetHeight;
      movesEl.scrollTop = Math.max(below - movesEl.clientHeight, Math.min(movesEl.scrollTop, active.offsetTop));
      const right = active.offsetLeft + active.offsetWidth;
      movesEl.scrollLeft = Math.max(right - movesEl.clientWidth, Math.min(movesEl.scrollLeft, active.offsetLeft));
    }
    nav.first.disabled = nav.prev.disabled = ply === 0;
    nav.next.disabled = nav.last.disabled = ply === total;

    updateClocks();
    renderActions();
    scheduleFit();
  }

  // On a narrow screen everything is stacked under the board, which is as
  // wide as the screen; on a short one the board gives up just enough of its
  // size for the rest to fit without scrolling.
  function fitBoard() {
    table.style.width = '';
    if (!NARROW.matches) return;
    const page = document.scrollingElement;
    const over = page.scrollHeight - page.clientHeight;
    if (over <= 0) return;
    const width = table.getBoundingClientRect().width;
    table.style.width = `${Math.max(width * MIN_FIT, width - over)}px`;
  }
  // Measured just before the next paint, once the platform has finished
  // changing the page around the game too (its header, the list it hides).
  let fitFrame = 0;
  function scheduleFit() {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(fitBoard);
  }
  window.addEventListener('resize', scheduleFit);

  // The server sends the clocks as of the snapshot; between snapshots the
  // running one is counted down locally. An earlier position is shown with
  // the time the players had left when it was reached.
  function updateClocks() {
    if (!game) return;
    const elapsed = performance.now() - gameAt;
    const { periodMs, options } = game;
    const then = viewPly === null ? null : game.clockHistory[viewPly - 1];
    const start = initialClock(options);
    for (const where of [top, bottom]) {
      const seat = Number(where.clock.dataset.seat);
      let clock = game.running === seat ? spend(game.clocks[seat], elapsed, periodMs) : game.clocks[seat];
      if (then) clock = then[seat];
      else if (viewPly === 0) clock = start;
      where.clock.querySelector('.time').textContent = formatClock(clock.ms);
      // In byo-yomi: the periods left, counting the one being used.
      const periods = where.clock.querySelector('.periods');
      periods.hidden = options.clock !== 'byoyomi';
      periods.textContent = `${clock.byo ? '' : '+'}${clock.periods + (clock.byo ? 1 : 0)}×${options.period}s`;
      const last = !clock.periods || options.clock !== 'byoyomi';
      where.clock.classList.toggle('low', clock.ms < LOW_TIME_MS && (last || clock.byo) && !game.over);
      const full = clock.byo ? periodMs : start.ms || periodMs;
      where.bar.firstChild.style.width = `${Math.min(100, (clock.ms / full) * 100)}%`;
    }
    if (game.scoring && !game.over) scoringLeft.textContent = formatClock(Math.max(0, game.scoring.msLeft - elapsed));
    // One warning when our own clock first drops into its last seconds.
    if (!watching() && game.running === game.you && lowTimeWarned !== game.id &&
        timeLeft(spend(game.clocks[game.you], elapsed, periodMs), periodMs) < LOW_TIME_MS) {
      lowTimeWarned = game.id;
      ctx.play('lowTime');
    }
  }
  const ticker = setInterval(updateClocks, 100);

  // Once the game is over the platform offers the rematch.
  function renderActions() {
    actionsEl.replaceChildren();
    if (game.over || watching()) return;
    const button = (textContent, action, props = {}) => el('button', {
      textContent,
      onclick: () => ctx.send({ action }),
      ...props,
    });
    const resign = el('button', {
      textContent: 'Resign',
      className: 'danger',
      onclick: () => {
        if (confirm('Resign this game?')) ctx.send({ action: 'resign' });
      },
    });
    if (game.scoring) {
      const accepted = game.scoring.accepted[game.you];
      actionsEl.append(
        accepted ? el('button', { textContent: 'Accepted', disabled: true }) : button('Accept score', 'acceptScore', { className: 'primary' }),
        button('Resume play', 'resume'),
        resign);
      return;
    }
    actionsEl.append(button('Pass', 'pass', { disabled: game.turn !== game.you }));
    // A move can be asked back once we have made one.
    const moved = replay.states.slice(0, game.played.length).some((state) => state.turn === game.you);
    // A bot grants it at once, so there is no waiting on it to show.
    const againstBot = Boolean(game.bots?.some(Boolean));
    if (game.takebackOffer === null || againstBot) actionsEl.append(button('Takeback', 'offerTakeback', { disabled: !moved }));
    else if (game.takebackOffer === game.you) actionsEl.append(el('button', { textContent: 'Takeback proposed', disabled: true }));
    else actionsEl.append(button('Accept takeback', 'acceptTakeback', { className: 'primary' }), button('Decline', 'declineTakeback'));
    actionsEl.append(resign);
  }

  function renderChat() {
    chatBody.hidden = !chatToggle.checked;
    chatList.replaceChildren(...chatMessages.map((m) => el('li', {}, el('strong', { textContent: m.from }), ` ${m.text}`)));
    chatList.scrollTop = chatList.scrollHeight;
  }
  function showChatSheet(open) {
    root.classList.toggle('chatOpen', open);
    if (open) chatOpen.classList.remove('unread');
    renderChat();
  }
  chatOpen.onclick = () => showChatSheet(true);
  chatClose.onclick = () => showChatSheet(false);
  chatToggle.addEventListener('change', () => {
    setChatEnabled(chatToggle.checked);
    renderChat();
  });
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text) ctx.sendChat(text);
    chatInput.value = '';
  });
  renderChat();

  return {
    update(snapshot) {
      // The same snapshot again means "redraw", e.g. after a refused move.
      if (snapshot !== game) {
        announce(game, snapshot);
        gameAt = performance.now();
        const sameGame = Boolean(game && game.id === snapshot.id);
        // A new move brings the board back to the present.
        if (!sameGame || snapshot.played.length !== game.played.length) viewPly = null;
      }
      game = snapshot;
      render();
      bot.update(snapshot);
    },
    chat(messages) {
      // One more message than before is a new one; anything else is the log.
      const added = messages.length === chatMessages.length + 1 ? messages[messages.length - 1] : null;
      chatMessages = messages.slice();
      if (added && chatToggle.checked && game && added.from !== game.players[game.you]) {
        ctx.play('notify');
        chatOpen.classList.toggle('unread', !root.classList.contains('chatOpen'));
      }
      renderChat();
    },
    destroy() {
      bot.destroy();
      board.destroy();
      clearInterval(ticker);
      release();
      chatOpen.remove();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', scheduleFit);
      cancelAnimationFrame(fitFrame);
      container.replaceChildren();
    },
  };
}

// Draws what the server's `preview` describes, for lists of games.
function preview(container, position) {
  drawThumbnail(container, position);
}

export default { inviteForm, botForm, describeOptions, describeResult, preview, settings, mount };

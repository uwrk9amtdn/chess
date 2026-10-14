// Mill in the browser: the options in the invitation dialog and the game
// screen. All game state comes from the server as snapshots; this file only
// draws them and sends the player's intent. See games/README.md.
//
// The frame of the screen and the setup widgets are the shared ones in
// public/js/kit; the board is Mill's own, in the kit's wood and stones.

import { VARIANTS, createGame, applyMove } from '../shared/rules.js';
import { BOT_LEVELS } from '../shared/search.js';
import { el, formatClock, load, save, LOW_TIME_MS } from '/js/kit/dom.js';
import { createScreen, stoneIcon, actionButton } from '/js/kit/screen.js';
import { settings } from '/js/kit/stonetheme.js';
import { choiceRow, slider, sliders, opponent, setupForm } from '/js/kit/setup.js';
import { createMillBoard, drawThumbnail } from './board.js';
import { createBot } from './bot/index.js';

const PRESETS = [[1, 0], [2, 1], [3, 0], [3, 2], [5, 0], [5, 3], [10, 0], [10, 5]];
const SETUP_KEY = 'mill.setup';
const SEATS = ['White', 'Black'];
// The stone colour of each seat, as the kit counts colours (0 is black).
const STONE = [1, 0];

const formatTimeControl = (minutes, increment) => `${minutes}+${increment}`;

// "3+2", with the board where it is not the usual one: "3+2 • Six".
function describeOptions({ variant, minutes, increment }) {
  const time = formatTimeControl(minutes, increment);
  return variant === 'nine' ? time : `${time} • ${VARIANTS[variant].short}`;
}

// The names of time controls by how long a game is likely to last: the
// minutes plus thirty moves' worth of increment.
function timeCategory(minutes, increment) {
  const seconds = minutes * 60 + 30 * increment;
  if (seconds < 120) return 'Bullet';
  if (seconds < 360) return 'Blitz';
  return 'Rapid';
}

// The values the sliders step through.
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const MINUTES = [...range(1, 20), 25, 30, 40, 45, 60];
const INCREMENTS = [...range(0, 20), 25, 30];

// The side a player may ask for against a bot, and the seat that is.
const SIDES = { white: 0, random: null, black: 1 };

// What was last sent from the game setup is offered again, and so are the
// bot's level and the side played against it.
function rememberedSetup() {
  const setup = { variant: 'nine', minutes: 3, increment: 2, level: 3, side: 'random' };
  const saved = load(SETUP_KEY) || {};
  if (Object.hasOwn(VARIANTS, saved.variant)) setup.variant = saved.variant;
  if (MINUTES.includes(saved.minutes)) setup.minutes = saved.minutes;
  if (INCREMENTS.includes(saved.increment)) setup.increment = saved.increment;
  if (Number.isInteger(saved.level) && saved.level >= 1 && saved.level <= BOT_LEVELS) setup.level = saved.level;
  if (Object.hasOwn(SIDES, saved.side)) setup.side = saved.side;
  return setup;
}

// The board above a grid of time controls: clicking one sends the
// invitation. "Custom" leads to sliders for any time.
function inviteForm(container, submit) {
  millSetup(container, submit, false);
}

// The same for a game against a bot, with its level and the side to play
// above. Submits { options, bot, seat }, which is what the lobby's "bot"
// message takes.
function botForm(container, submit) {
  millSetup(container, submit, true);
}

function millSetup(container, submit, bot) {
  const setup = rememberedSetup();
  const done = () => {
    save(SETUP_KEY, setup);
    const { variant, minutes, increment } = setup;
    const options = { variant, minutes, increment };
    if (!bot) return submit(options);
    submit({ options, bot: { level: setup.level }, seat: SIDES[setup.side] });
  };
  const about = el('p', { className: 'kitMuted kitAbout' });
  const render = () => {
    about.textContent = `${VARIANTS[setup.variant].description} White moves first; with three pieces left, a player may jump anywhere.`;
  };
  const variants = choiceRow(Object.values(VARIANTS).map((v) => [v.id, v.short]), setup.variant, (variant) => {
    setup.variant = variant;
    render();
  });
  render();
  const top = [variants, about];
  if (bot) top.unshift(opponent(setup, BOT_LEVELS, Object.keys(SIDES).map((s) => [s, s[0].toUpperCase() + s.slice(1)])));
  const minutes = slider(setup, 'minutes', 'Minutes per side', MINUTES);
  const increment = slider(setup, 'increment', 'Increment in seconds', INCREMENTS);
  setupForm(container, {
    top,
    tiles: PRESETS.map(([m, i]) => ({
      title: formatTimeControl(m, i),
      subtitle: timeCategory(m, i),
      onclick: () => {
        Object.assign(setup, { minutes: m, increment: i });
        done();
      },
    })),
    custom: [sliders(minutes.node, increment.node)],
    submitLabel: bot ? 'Play' : 'Send invitation',
    onSubmit: done,
  });
}

// How each ending reads, given the side that lost: "Black cannot move".
const ENDINGS = {
  pieces: (loser) => `${loser} has two pieces left`,
  blocked: (loser) => `${loser} cannot move`,
  resign: (loser) => `${loser} resigned`,
  timeout: (loser) => `${loser} ran out of time`,
  abandoned: (loser) => `${loser} left the game`,
  full: () => 'Board full',
  repetition: () => 'Threefold repetition',
  quiet: () => 'Fifty moves each without a mill',
  agreement: () => 'Mutual agreement',
};

// { score: '1-0', how: 'Black cannot move', text: 'Black cannot move • White is victorious' }
function resultOf({ reason, winner }) {
  if (winner === null) {
    const how = ENDINGS[reason]();
    return { score: '½-½', how, text: `${how} • Draw` };
  }
  const how = ENDINGS[reason](SEATS[1 - winner]);
  return { score: winner === 0 ? '1-0' : '0-1', how, text: `${how} • ${SEATS[winner]} is victorious` };
}

// "1-0 • Black cannot move", for lists of finished games.
function describeResult({ over }) {
  const { score, how } = resultOf(over);
  return `${score} • ${how}`;
}

function mount(container, ctx) {
  let game = null; // latest snapshot from the server
  let gameAt = 0; // performance.now() when it arrived, for ticking the clock
  let lowTimeWarned = null; // id of the game we already beeped for
  let viewPly = null; // the earlier position being looked at, or null for the latest
  let replay = { key: null, states: [] }; // the position after each move of one game
  let shown = { id: null, ply: 0 }; // what the board showed last
  let taking = false; // the player has closed a mill and is choosing what to take
  // Plays the other seat when this is a game against a bot.
  const bot = createBot(ctx);

  const screen = createScreen(container, ctx, { chatKey: 'mill.chat', onGo: (ply) => go(ply) });
  const { top, bottom } = screen;
  const board = createMillBoard(screen.board, {
    onMove: (move) => ctx.send({ action: 'move', ...move }),
    onTaking: (now) => {
      taking = now;
      if (game) screen.status.replaceChildren(statusText());
    },
  });

  const watching = () => game.you === null;
  // Our own seat is at the bottom of the panel; a spectator sits with
  // White. The board is the same way up for everyone.
  const bottomSeat = () => game.you ?? 0;
  const topSeat = () => 1 - bottomSeat();
  const variant = () => VARIANTS[game.options.variant];

  // Plays the sound of the move that led to the position after `ply` moves.
  function playMove(ply) {
    ctx.play(game.played[ply - 1].remove === undefined ? 'move' : 'capture');
  }

  // Plays the sounds for whatever changed between two snapshots of one game.
  function announce(prev, next) {
    const same = Boolean(prev && prev.id === next.id);
    if (same && next.played.length > prev.played.length) {
      ctx.play(next.played[next.played.length - 1].remove === undefined ? 'move' : 'capture');
    }
    if (same && next.over && !prev.over) ctx.play('end', 0.3);
    for (const offer of ['drawOffer', 'takebackOffer']) {
      const offered = (g) => g.you !== null && g[offer] !== null && g[offer] !== g.you;
      if (offered(next) && !(same && offered(prev))) ctx.play('notify');
    }
  }

  // The server sends the moves; replaying them gives every position of the
  // game, which is what lets the player step back through it.
  function positions() {
    // After a takeback the moves are no longer the ones replayed so far.
    const key = `${game.id}:${game.takebacks}`;
    if (replay.key !== key) replay = { key, states: [createGame(variant())] };
    const { states } = replay;
    for (let i = states.length - 1; i < game.played.length; i++) states.push(applyMove(states[i], variant(), game.played[i]));
    return states;
  }

  // Looks at the position after `ply` moves without changing the game.
  function go(ply) {
    if (!game) return;
    const total = game.played.length;
    const clamped = Math.max(0, Math.min(total, ply));
    // Stepping through the game sounds like the moves being played.
    if (clamped && clamped !== (viewPly ?? total)) playMove(clamped);
    viewPly = clamped === total ? null : clamped;
    render();
  }

  // What the player to move is to do: put a piece down, move one, or jump.
  function task(seat) {
    if (game.inHand[seat]) return `put down a piece (${game.inHand[seat]} left)`;
    return game.onBoard[seat] === 3 ? 'jump a piece anywhere' : 'move a piece';
  }

  function statusText() {
    if (game.drawOffer !== null && game.drawOffer !== game.you) return `${game.players[game.drawOffer]} offers a draw`;
    if (game.takebackOffer !== null && game.takebackOffer !== game.you) {
      return `${game.players[game.takebackOffer]} proposes a takeback`;
    }
    if (watching()) return `${SEATS[game.turn]} to ${task(game.turn).replace(/ \(.*/, '')}`;
    if (game.turn !== game.you) return `Waiting for ${game.players[game.turn]}`;
    if (taking) return 'A mill! Take one of the opponent\'s pieces';
    const text = task(game.you);
    return `Your move: ${text}`;
  }

  function render() {
    const states = positions();
    const total = game.played.length;
    const ply = viewPly ?? total;
    const state = states[ply];
    const live = !game.over;
    const mode = live && ply === total && !watching() && game.turn === game.you ? 'play' : 'none';

    board.update({
      state,
      variant: variant(),
      lastMove: ply ? game.played[ply - 1] : null,
      mode,
      // One step forward or back slides and fades; a longer jump just shows
      // the position.
      animate: shown.id === game.id && Math.abs(ply - shown.ply) <= 1,
    });
    shown = { id: game.id, ply };

    for (const [where, seat] of [[top, topSeat()], [bottom, bottomSeat()]]) {
      // Who is still connected says nothing once the game is over.
      screen.setPlayer(where, { name: game.players[seat], colour: STONE[seat], connected: live ? game.connected[seat] : null });
      where.clock.dataset.seat = seat;
      // The pieces still to be put down, and those on the board.
      const parts = [];
      if (state.inHand[seat]) parts.push(`${state.inHand[seat]} in hand`);
      parts.push(`${state.onBoard[seat]} on the board`);
      where.extra.replaceChildren(stoneIcon(STONE[seat]), parts.join(' • '));
    }

    const v = variant();
    screen.info.replaceChildren(
      el('div', { className: 'kitTime' }, el('span', { className: 'kitIcon', textContent: '⊞' }),
        `${formatTimeControl(game.options.minutes, game.options.increment)} • ${v.name}`),
      el('div', { className: 'kitMuted', textContent: v.description }),
      el('div', { className: 'kitNames' }, ...game.players.map((name, seat) => el('div', {}, stoneIcon(STONE[seat]), name))),
      el('div', { className: 'kitWatchers', hidden: !game.spectators || !live, textContent: `${game.spectators} watching` }));
    const result = game.over && resultOf(game.over);
    if (result) screen.info.append(el('div', { className: 'kitResult', textContent: result.text }));
    // A bot has nothing to say.
    screen.setChatAvailable(!watching() && !game.bots?.some(Boolean));
    if (result) screen.status.replaceChildren(el('strong', { textContent: result.score }), el('em', { textContent: result.text }));
    else screen.status.replaceChildren(statusText());
    screen.status.classList.toggle('over', !live);

    screen.setMoves(game.moves, ply);
    screen.setNav(ply, total);
    updateClocks();
    renderActions();
    screen.fit();
  }

  // The server sends the clocks as of the snapshot; between snapshots the
  // running one is counted down locally. An earlier position is shown with
  // the time the players had left when it was reached.
  function updateClocks() {
    if (!game) return;
    const elapsed = performance.now() - gameAt;
    const then = viewPly === null ? null : game.clockHistory[viewPly - 1];
    for (const where of [top, bottom]) {
      const seat = Number(where.clock.dataset.seat);
      let ms = Math.max(0, game.clocks[seat] - (game.running === seat ? elapsed : 0));
      if (then) ms = then[seat];
      else if (viewPly === 0) ms = game.initialMs;
      screen.setClock(where, {
        time: formatClock(ms),
        active: !game.over && game.running === seat,
        low: ms < LOW_TIME_MS && !game.over,
        fill: ms / game.initialMs,
      });
    }
    // One warning when our own clock first drops into its last seconds.
    if (!watching() && game.running === game.you && lowTimeWarned !== game.id && game.clocks[game.you] - elapsed < LOW_TIME_MS) {
      lowTimeWarned = game.id;
      ctx.play('lowTime');
    }
  }
  const ticker = setInterval(updateClocks, 100);

  // Once the game is over the platform offers the rematch.
  function renderActions() {
    const { actions } = screen;
    actions.replaceChildren();
    if (game.over || watching()) return;
    const button = (text, action, props) => actionButton(ctx, text, action, props);
    // A move can be asked back once we have made one.
    const moved = replay.states.slice(0, game.played.length).some((s) => s.turn === game.you);
    // A bot grants it at once, so there is no waiting on it to show.
    const againstBot = Boolean(game.bots?.some(Boolean));
    if (game.takebackOffer === null || againstBot) actions.append(button('Takeback', 'offerTakeback', { disabled: !moved }));
    else if (game.takebackOffer === game.you) actions.append(el('button', { textContent: 'Takeback proposed', disabled: true }));
    else actions.append(button('Accept takeback', 'acceptTakeback', { className: 'primary' }), button('Decline', 'declineTakeback'));
    if (game.drawOffer === null) actions.append(button('Offer draw', 'offerDraw'));
    else if (game.drawOffer === game.you) actions.append(el('button', { textContent: 'Draw offered', disabled: true }));
    else actions.append(button('Accept draw', 'acceptDraw', { className: 'primary' }), button('Decline', 'declineDraw'));
    actions.append(el('button', {
      textContent: 'Resign',
      className: 'danger',
      onclick: () => {
        if (confirm('Resign this game?')) ctx.send({ action: 'resign' });
      },
    }));
  }

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
      screen.chat(messages, game ? game.players[game.you] : null);
    },
    destroy() {
      bot.destroy();
      board.destroy();
      clearInterval(ticker);
      screen.destroy();
    },
  };
}

// Draws what the server's `preview` describes, for lists of games.
function preview(container, { variant, ...position }) {
  drawThumbnail(container, { variant: VARIANTS[variant], ...position });
}

export default { inviteForm, botForm, describeOptions, describeResult, preview, settings, mount };

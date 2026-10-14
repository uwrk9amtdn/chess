// Gomoku in the browser: the options in the invitation dialog and the game
// screen. All game state comes from the server as snapshots; this file only
// draws them and sends the player's intent. See games/README.md.
//
// The frame of the screen, the board and the setup widgets are the shared
// ones in public/js/kit, which Go uses too.

import { createGame, applyMove, tryMove, forbiddenPoints, starPoints, VARIANTS, LETTERS } from '../shared/rules.js';
import { BOT_LEVELS } from '../shared/search.js';
import { el, formatClock, load, save, LOW_TIME_MS } from '/js/kit/dom.js';
import { createScreen, stoneIcon, actionButton } from '/js/kit/screen.js';
import { createStoneBoard, drawThumbnail } from '/js/kit/stoneboard.js';
import { settings } from '/js/kit/stonetheme.js';
import { choiceRow, slider, sliders, opponent, setupForm } from '/js/kit/setup.js';
import { createBot } from './bot/index.js';

const PRESETS = [[1, 1], [3, 0], [3, 2], [5, 3], [10, 0], [10, 5], [15, 10], [30, 20]];
const SETUP_KEY = 'gomoku.setup';
const COLOURS = ['Black', 'White'];
const OPENINGS = { none: 'Black starts', swap2: 'Swap2' };

const formatTimeControl = (minutes, increment) => `${minutes}+${increment}`;

// "5+3 • Renju", with a 19x19 board and Swap2 where chosen.
function describeOptions({ variant, size, opening, minutes, increment }) {
  let text = `${formatTimeControl(minutes, increment)} • ${VARIANTS[variant].name}`;
  if (size !== 15) text += ` ${size}×${size}`;
  if (opening === 'swap2') text += ' • Swap2';
  return text;
}

// The names of time controls by how long a game is likely to last: the
// minutes plus thirty moves' worth of increment.
function timeCategory(minutes, increment) {
  const seconds = minutes * 60 + 30 * increment;
  if (seconds < 180) return 'Bullet';
  if (seconds < 480) return 'Blitz';
  return seconds < 1500 ? 'Rapid' : 'Classical';
}

// The values the sliders step through.
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const MINUTES = [...range(1, 20), 25, 30, 35, 40, 45, 60];
const INCREMENTS = [...range(0, 20), 25, 30];

// The seat a player may ask for against a bot. Without an opening rule the
// first seat plays Black; with Swap2 it lays down the opening.
const SIDES = { first: 0, random: null, second: 1 };
const sideLabels = (opening) => (opening === 'swap2'
  ? { first: 'Open', random: 'Random', second: 'Choose' }
  : { first: 'Black', random: 'Random', second: 'White' });

// What was last sent from the game setup is offered again, and so are the
// bot's level and the side played against it.
function rememberedSetup() {
  const setup = { variant: 'freestyle', size: 15, opening: 'none', minutes: 5, increment: 3, level: 3, side: 'random' };
  const saved = load(SETUP_KEY) || {};
  if (Object.hasOwn(VARIANTS, saved.variant)) setup.variant = saved.variant;
  if (VARIANTS[setup.variant].sizes.includes(saved.size)) setup.size = saved.size;
  if (Object.hasOwn(OPENINGS, saved.opening)) setup.opening = saved.opening;
  if (MINUTES.includes(saved.minutes)) setup.minutes = saved.minutes;
  if (INCREMENTS.includes(saved.increment)) setup.increment = saved.increment;
  if (Number.isInteger(saved.level) && saved.level >= 1 && saved.level <= BOT_LEVELS) setup.level = saved.level;
  if (Object.hasOwn(SIDES, saved.side)) setup.side = saved.side;
  return setup;
}

// The rules, the board and the opening above a grid of time controls:
// clicking one sends the invitation. "Custom" leads to sliders for any time.
function inviteForm(container, submit) {
  gomokuSetup(container, submit, false);
}

// The same for a game against a bot, with its level and the side to play
// above. Submits { options, bot, seat }, which is what the lobby's "bot"
// message takes.
function botForm(container, submit) {
  gomokuSetup(container, submit, true);
}

function gomokuSetup(container, submit, bot) {
  const setup = rememberedSetup();
  const done = () => {
    save(SETUP_KEY, setup);
    const { variant, size, opening, minutes, increment } = setup;
    const options = { variant, size, opening, minutes, increment };
    if (!bot) return submit(options);
    submit({ options, bot: { level: setup.level }, seat: SIDES[setup.side] });
  };

  const about = el('p', { className: 'kitMuted kitAbout' });
  const sizes = choiceRow([[15, '15×15'], [19, '19×19']], setup.size, (size) => {
    setup.size = size;
  }, 'kitTopChoice');
  const variants = choiceRow(Object.values(VARIANTS).map((v) => [v.id, v.name]), setup.variant, (variant) => {
    setup.variant = variant;
    renderRules();
  });
  const openings = choiceRow(Object.entries(OPENINGS), setup.opening, (opening) => {
    setup.opening = opening;
    renderRules();
  }, 'kitTopChoice');
  const rival = bot ? opponent(setup, BOT_LEVELS, Object.keys(SIDES).map((s) => [s, s])) : null;

  // Only Freestyle has a larger board; the side buttons say what each seat
  // does under the chosen opening.
  function renderRules() {
    const { sizes: allowed, description } = VARIANTS[setup.variant];
    if (!allowed.includes(setup.size)) setup.size = allowed[0];
    sizes.select(setup.size);
    sizes.disable(19, !allowed.includes(19));
    about.textContent = `${description} ${setup.opening === 'swap2'
      ? 'Swap2: the first player lays down three stones, the second takes a colour or lays down two more and lets the first choose.'
      : 'Black moves first.'}`;
    if (rival) {
      const labels = sideLabels(setup.opening);
      [...rival.sides.children].forEach((button, i) => {
        button.textContent = labels[Object.keys(SIDES)[i]];
      });
    }
  }
  renderRules();

  const minutes = slider(setup, 'minutes', 'Minutes per side', MINUTES);
  const increment = slider(setup, 'increment', 'Increment in seconds', INCREMENTS);
  setupForm(container, {
    top: [...(rival ? [rival] : []), variants, about, sizes, openings],
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

// How each ending reads, given who lost: "White resigned".
const ENDINGS = {
  five: () => 'Five in a row',
  full: () => 'Board full',
  resign: (loser) => `${loser} resigned`,
  timeout: (loser) => `${loser} ran out of time`,
  abandoned: (loser) => `${loser} left the game`,
};

// { score: 'Black wins', how: 'Five in a row', text: 'Five in a row • Black is victorious' }.
// The sides go by colour, or by name when the game ended before Swap2 gave
// them one.
function resultOf({ players, over }) {
  const { reason, winner, colour } = over;
  if (winner === null) return { score: 'Draw', how: ENDINGS[reason](), text: `${ENDINGS[reason]()} • Draw` };
  const name = (won) => (colour === null ? players[won ? winner : 1 - winner] : COLOURS[won ? colour : 1 - colour]);
  const how = ENDINGS[reason](name(false));
  return { score: `${name(true)} wins`, how, text: `${how} • ${name(true)} is victorious` };
}

// "Black wins • Five in a row", for lists of finished games.
function describeResult(match) {
  const { score, how } = resultOf(match);
  return `${score} • ${how}`;
}

function mount(container, ctx) {
  let game = null; // latest snapshot from the server
  let gameAt = 0; // performance.now() when it arrived, for ticking the clock
  let lowTimeWarned = null; // id of the game we already beeped for
  let viewPly = null; // the earlier position being looked at, or null for the latest
  let replay = { key: null, states: [] }; // the position after each stone of one game
  let shown = { id: null, ply: 0 }; // what the board showed last
  let forbidden = { key: null, points: [] }; // Renju's forbidden points, worked out once per position
  // Plays the other seat when this is a game against a bot.
  const bot = createBot(ctx);

  const screen = createScreen(container, ctx, { chatKey: 'gomoku.chat', onGo: (ply) => go(ply) });
  const { top, bottom } = screen;
  const board = createStoneBoard(screen.board, {
    onPlay: (point) => ctx.send({ action: 'move', point }),
    letters: LETTERS,
    stars: starPoints,
  });

  const watching = () => game.you === null;
  // Our own seat is at the bottom of the panel; a spectator sits with the
  // first seat. The board is the same way up for everyone.
  const bottomSeat = () => game.you ?? 0;
  const topSeat = () => 1 - bottomSeat();
  const variant = () => game.options.variant;

  // Plays the sounds for whatever changed between two snapshots of one game.
  function announce(prev, next) {
    const same = Boolean(prev && prev.id === next.id);
    if (same && next.played.length > prev.played.length) ctx.play('move');
    if (same && next.over && !prev.over) ctx.play('end', 0.3);
    // Our turn to choose a colour is worth noticing.
    const choosing = (g) => g.you !== null && g.actor === g.you && (g.step === 'choose' || g.step === 'choose2');
    if (choosing(next) && !(same && choosing(prev))) ctx.play('notify');
    const offered = (g) => g.you !== null && g.takebackOffer !== null && g.takebackOffer !== g.you;
    if (offered(next) && !(same && offered(prev))) ctx.play('notify');
  }

  // The server sends the stones; replaying them gives every position of the
  // game, which is what lets the player step back through it.
  function positions() {
    // After a takeback the stones are no longer the ones replayed so far.
    const key = `${game.id}:${game.takebacks}`;
    if (replay.key !== key) replay = { key, states: [createGame(game.options.size)] };
    const { states } = replay;
    for (let i = states.length - 1; i < game.played.length; i++) states.push(applyMove(states[i], game.played[i], variant()));
    return states;
  }

  // Looks at the position after `ply` stones without changing the game.
  function go(ply) {
    if (!game) return;
    const total = game.played.length;
    const clamped = Math.max(0, Math.min(total, ply));
    // Stepping through the game sounds like the stones being played.
    if (clamped && clamped !== (viewPly ?? total)) ctx.play('move');
    viewPly = clamped === total ? null : clamped;
    render();
  }

  // Where Black may not play, for the player who has Black to move in Renju.
  function forbiddenFor(state, mode) {
    if (mode !== 'play' || game.step || variant() !== 'renju') return null;
    const key = `${game.id}:${game.takebacks}:${state.count}`;
    if (forbidden.key !== key) forbidden = { key, points: forbiddenPoints(state, 'renju') };
    return forbidden.points;
  }

  // What the opening asks of whoever is to act, in their words or others'.
  function openingText() {
    const mine = game.actor === game.you;
    const who = game.players[game.actor];
    const left = (until) => until - game.played.length;
    switch (game.step) {
      case 'place3': return mine
        ? `Lay down the opening: black, white, black (${left(3)} to go)`
        : `${who} is laying down the opening`;
      case 'choose': return mine ? 'Take a colour, or lay down two more stones' : `${who} is choosing a colour`;
      case 'place2': return mine ? `Lay down two more: white, then black (${left(5)} to go)` : `${who} is laying down two more stones`;
      default: return mine ? 'Take a colour' : `${who} is choosing a colour`;
    }
  }

  function statusText() {
    if (game.takebackOffer !== null && game.takebackOffer !== game.you) {
      return `${game.players[game.takebackOffer]} proposes a takeback`;
    }
    if (game.step) return openingText();
    if (watching()) return `${COLOURS[game.turn]} to play`;
    return game.actor === game.you ? 'Your move' : `Waiting for ${game.players[game.actor]}`;
  }

  function render() {
    const states = positions();
    const total = game.played.length;
    const ply = viewPly ?? total;
    const state = states[ply];
    const live = !game.over;
    const placing = !game.step || game.step === 'place3' || game.step === 'place2';
    const mode = live && ply === total && !watching() && game.actor === game.you && placing ? 'play' : 'none';

    board.update({
      size: state.size,
      stones: state.board,
      lastMove: ply ? game.played[ply - 1] : null,
      mode,
      // Opening stones alternate in colour, as every stone does.
      colour: state.turn,
      isLegal: (point) => !tryMove(state, point, variant()).error,
      forbidden: forbiddenFor(state, mode),
      line: ply === total ? game.line : null,
      // One step forward or back fades the stone in or out; a longer jump
      // just shows the position.
      animate: shown.id === game.id && Math.abs(ply - shown.ply) <= 1,
    });
    shown = { id: game.id, ply };

    for (const [where, seat] of [[top, topSeat()], [bottom, bottomSeat()]]) {
      // Who is still connected says nothing once the game is over.
      screen.setPlayer(where, { name: game.players[seat], colour: game.colours[seat], connected: live ? game.connected[seat] : null });
      where.clock.dataset.seat = seat;
    }

    const { options } = game;
    const rules = VARIANTS[options.variant];
    screen.info.replaceChildren(
      el('div', { className: 'kitTime' }, el('span', { className: 'kitIcon', textContent: '⁙' }),
        `${formatTimeControl(options.minutes, options.increment)} • ${rules.name} • ${options.size}×${options.size}`),
      el('div', { className: 'kitMuted', textContent: `${rules.description}${options.opening === 'swap2' ? ' Swap2 opening.' : ''}` }),
      el('div', { className: 'kitNames' }, ...game.players.map((name, seat) => el('div', {}, stoneIcon(game.colours[seat]), name))),
      el('div', { className: 'kitWatchers', hidden: !game.spectators || !live, textContent: `${game.spectators} watching` }));
    const result = game.over && resultOf(game);
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
    const choose = (text, choice, props = {}) => el('button', { textContent: text, onclick: () => ctx.send({ action: 'choose', choice }), ...props });
    const resign = el('button', {
      textContent: 'Resign',
      className: 'danger',
      onclick: () => {
        if (confirm('Resign this game?')) ctx.send({ action: 'resign' });
      },
    });
    const mine = game.actor === game.you;
    if ((game.step === 'choose' || game.step === 'choose2') && mine) {
      actions.append(choose('Play black', 'black', { className: 'primary' }), choose('Play white', 'white', { className: 'primary' }));
      if (game.step === 'choose') actions.append(choose('Lay down two more', 'placeTwo'));
      actions.append(resign);
      return;
    }
    if (game.step) {
      actions.append(resign);
      return;
    }
    // A move can be asked back once we have played a stone of our own after
    // the opening.
    const moved = replay.states.slice(game.openingPlies, game.played.length).some((s) => s.turn === game.colours[game.you]);
    // A bot grants it at once, so there is no waiting on it to show.
    const againstBot = Boolean(game.bots?.some(Boolean));
    if (game.takebackOffer === null || againstBot) actions.append(button('Takeback', 'offerTakeback', { disabled: !moved }));
    else if (game.takebackOffer === game.you) actions.append(el('button', { textContent: 'Takeback proposed', disabled: true }));
    else actions.append(button('Accept takeback', 'acceptTakeback', { className: 'primary' }), button('Decline', 'declineTakeback'));
    actions.append(resign);
  }

  return {
    update(snapshot) {
      // The same snapshot again means "redraw", e.g. after a refused move.
      if (snapshot !== game) {
        announce(game, snapshot);
        gameAt = performance.now();
        const sameGame = Boolean(game && game.id === snapshot.id);
        // A new stone brings the board back to the present.
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
function preview(container, position) {
  drawThumbnail(container, { ...position, stars: starPoints(position.size) });
}

export default { inviteForm, botForm, describeOptions, describeResult, preview, settings, mount };

// Go in the browser: the options in the invitation dialog and the game
// screen. All game state comes from the server as snapshots; this file only
// draws them and sends the player's intent. See games/README.md.
//
// The frame of the screen, the board and the setup widgets are the shared
// ones in public/js/kit, which Gomoku uses too.

import { createGame, applyMove, isLegal, score, starPoints, SIZES, MAX_HANDICAP, BLACK } from '../shared/rules.js';
import { initialClock, spend, timeLeft } from '../shared/clock.js';
import { BOT_LEVELS } from '../shared/mcts.js';
import { el, formatClock, load, save, LOW_TIME_MS } from '/js/kit/dom.js';
import { createScreen, stoneIcon, actionButton } from '/js/kit/screen.js';
import { createStoneBoard, drawThumbnail } from '/js/kit/stoneboard.js';
import { settings } from '/js/kit/stonetheme.js';
import { choiceRow, slider, sliders, opponent, setupForm } from '/js/kit/setup.js';
import { createBot } from './bot/index.js';

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
const COLOURS = ['Black', 'White'];
// Column letters skip I, as in shared/rules.js.
const LETTERS = 'ABCDEFGHJKLMNOPQRST';

// "10+5" for Fischer, "10m 5×30s" for byo-yomi.
function formatTimeControl({ clock, minutes, increment, periods, period }) {
  if (clock === 'byoyomi') return `${minutes ? `${minutes}m ` : ''}${periods}×${period}s`;
  return `${minutes}+${increment}`;
}

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
  const saved = load(SETUP_KEY) || {};
  if (SIZES.includes(saved.size)) setup.size = saved.size;
  if (HANDICAPS.includes(saved.handicap)) setup.handicap = saved.handicap;
  if (Object.hasOwn(CLOCKS, saved.clock)) setup.clock = saved.clock;
  if (MAIN_MINUTES.includes(saved.minutes)) setup.minutes = saved.minutes;
  if (INCREMENTS.includes(saved.increment)) setup.increment = saved.increment;
  if (PERIODS.includes(saved.periods)) setup.periods = saved.periods;
  if (PERIOD_SECONDS.includes(saved.period)) setup.period = saved.period;
  if (Number.isInteger(saved.level) && saved.level >= 1 && saved.level <= BOT_LEVELS) setup.level = saved.level;
  if (Object.hasOwn(SIDES, saved.side)) setup.side = saved.side;
  // Fischer needs some main time.
  if (setup.clock === 'fischer' && !setup.minutes) setup.minutes = 1;
  return setup;
}

// The options of a game from the setup: only the fields its clock uses.
function optionsOf(setup) {
  const { size, handicap, clock, minutes } = setup;
  return clock === 'fischer'
    ? { size, handicap, clock, minutes, increment: setup.increment }
    : { size, handicap, clock, minutes, periods: setup.periods, period: setup.period };
}

// First the board size and a grid of time controls: clicking one sends an
// invitation to an even game. "Custom" leads to the game setup, where the
// handicap and any time control can be chosen.
function inviteForm(container, submit) {
  goSetup(container, submit, false);
}

// The same for a game against a bot, with its level and the side to play
// above both. Submits { options, bot, seat }, which is what the lobby's "bot"
// message takes.
function botForm(container, submit) {
  goSetup(container, submit, true);
}

function goSetup(container, submit, bot) {
  const setup = rememberedSetup();
  const done = (options) => {
    save(SETUP_KEY, setup);
    if (!bot) return submit(options);
    submit({ options, bot: { level: setup.level }, seat: SIDES[setup.side] });
  };

  const sizes = choiceRow(SIZES.map((s) => [s, `${s}×${s}`]), setup.size, (size) => {
    setup.size = size;
  }, 'kitTopChoice');

  const handicap = slider(setup, 'handicap', 'Handicap', HANDICAPS, (h) => (h ? `${h} stones` : 'None'));
  const fischerMinutes = slider(setup, 'minutes', 'Minutes per side', MINUTES);
  const increment = slider(setup, 'increment', 'Increment in seconds', INCREMENTS);
  const mainMinutes = slider(setup, 'minutes', 'Main time in minutes', MAIN_MINUTES);
  const periods = slider(setup, 'periods', 'Periods', PERIODS);
  const period = slider(setup, 'period', 'Seconds per period', PERIOD_SECONDS);
  const all = [handicap, fischerMinutes, increment, mainMinutes, periods, period];
  const fischerBox = sliders(fischerMinutes.node, increment.node);
  const byoBox = sliders(mainMinutes.node, periods.node, period.node);
  function renderClock() {
    if (setup.clock === 'fischer' && !setup.minutes) setup.minutes = 1;
    fischerBox.hidden = setup.clock !== 'fischer';
    byoBox.hidden = setup.clock !== 'byoyomi';
    for (const s of all) s.render();
  }
  const clocks = choiceRow(Object.entries(CLOCKS), setup.clock, (clock) => {
    setup.clock = clock;
    renderClock();
  });
  renderClock();

  const top = [sizes];
  if (bot) top.unshift(opponent(setup, BOT_LEVELS, Object.keys(SIDES).map((s) => [s, s[0].toUpperCase() + s.slice(1)])));
  setupForm(container, {
    top,
    tiles: PRESETS.map((preset) => ({
      title: formatTimeControl(preset),
      subtitle: CLOCKS[preset.clock],
      onclick: () => {
        Object.assign(setup, preset);
        done(optionsOf({ ...setup, handicap: 0 }));
      },
    })),
    custom: [sliders(handicap.node), clocks, fischerBox, byoBox],
    submitLabel: bot ? 'Play' : 'Send invitation',
    onSubmit: () => done(optionsOf(setup)),
  });
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
  let game = null; // latest snapshot from the server
  let gameAt = 0; // performance.now() when it arrived, for ticking the clock
  let lowTimeWarned = null; // id of the game we already beeped for
  let viewPly = null; // the earlier position being looked at, or null for the latest
  let replay = { key: null, states: [] }; // the position after each move of one game
  let shown = { id: null, ply: 0 }; // what the board showed last
  // Plays the other seat when this is a game against a bot.
  const bot = createBot(ctx);

  const screen = createScreen(container, ctx, { chatKey: 'go.chat', onGo: (ply) => go(ply) });
  const { top, bottom } = screen;
  const board = createStoneBoard(screen.board, {
    onPlay: (point) => ctx.send({ action: 'move', point }),
    onToggle: (point) => ctx.send({ action: 'toggleDead', point }),
    letters: LETTERS,
    stars: starPoints,
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
    if (!game) return;
    const total = game.played.length;
    const clamped = Math.max(0, Math.min(total, ply));
    // Stepping through the game sounds like the moves being played.
    if (clamped && clamped !== (viewPly ?? total)) playMove(replay.states, clamped);
    viewPly = clamped === total ? null : clamped;
    render();
  }

  // The stones marked dead and who owns what, while counting and at the end
  // of a counted game; null otherwise.
  function counting(state, ply) {
    if (ply !== game.played.length) return null;
    const dead = game.scoring ? game.scoring.dead : counted(game.over) ? game.dead : null;
    if (!dead) return null;
    return { dead: new Set(dead), ...score(state, dead, game.komi) };
  }

  const scoringLeft = el('span', { className: 'kitCountdown' });

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
      size: state.size,
      stones: state.board,
      lastMove: last && !last.pass ? last.point : null,
      mode,
      colour: game.you ?? BLACK,
      isLegal: (point) => isLegal(state, { point }),
      afterPlay: (point) => applyMove(state, { point }).board,
      owner: count?.owner ?? null,
      dead: count?.dead ?? null,
      // One step forward or back fades the stones in and out; a longer jump
      // just shows the position.
      animate: shown.id === game.id && Math.abs(ply - shown.ply) <= 1,
    });
    shown = { id: game.id, ply };

    for (const [where, seat] of [[top, topSeat()], [bottom, bottomSeat()]]) {
      // Who is still connected says nothing once the game is over.
      screen.setPlayer(where, { name: game.players[seat], colour: seat, connected: live ? game.connected[seat] : null });
      where.clock.dataset.seat = seat;
      // The stones this player has taken, which are the other colour.
      const taken = state.captures[seat];
      where.extra.replaceChildren(...(taken ? [stoneIcon(1 - seat), `${taken} captured`] : []));
    }

    const { size, handicap } = game.options;
    screen.info.replaceChildren(
      el('div', { className: 'kitTime' }, el('span', { className: 'kitIcon', textContent: '◉︎' }),
        `${formatTimeControl(game.options)} • ${CLOCKS[game.options.clock]} • ${size}×${size}`),
      el('div', { className: 'kitMuted', textContent: `${handicap ? `${handicap} handicap stones • ` : ''}Komi ${game.komi} • Area scoring` }),
      el('div', { className: 'kitNames' }, ...game.players.map((name, seat) => el('div', {}, stoneIcon(seat), name))),
      el('div', { className: 'kitWatchers', hidden: !game.spectators || !live, textContent: `${game.spectators} watching` }));
    const result = game.over && resultOf(game.over);
    if (result) screen.info.append(el('div', { className: 'kitResult', textContent: result.text }));
    // A bot has nothing to say.
    screen.setChatAvailable(!watching() && !game.bots?.some(Boolean));
    if (result) {
      const counts = counted(game.over) ? [el('span', { textContent: `Black ${game.over.black} • White ${game.over.white}` })] : [];
      screen.status.replaceChildren(el('strong', { textContent: result.score }), el('em', { textContent: result.text }), ...counts);
    } else screen.status.replaceChildren(statusText(game.scoring && count));
    screen.status.classList.toggle('over', !live);
    screen.status.classList.toggle('detail', Boolean(live && game.scoring));

    screen.setMoves(game.moves, ply, (name) => (name === 'Pass' ? 'pass' : ''));
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
    const { periodMs, options } = game;
    const then = viewPly === null ? null : game.clockHistory[viewPly - 1];
    const start = initialClock(options);
    for (const where of [top, bottom]) {
      const seat = Number(where.clock.dataset.seat);
      let clock = game.running === seat ? spend(game.clocks[seat], elapsed, periodMs) : game.clocks[seat];
      if (then) clock = then[seat];
      else if (viewPly === 0) clock = start;
      const byoyomi = options.clock === 'byoyomi';
      const lastPeriod = !clock.periods || !byoyomi;
      screen.setClock(where, {
        time: formatClock(clock.ms),
        // In byo-yomi: the periods left, counting the one being used.
        label: byoyomi ? `${clock.byo ? '' : '+'}${clock.periods + (clock.byo ? 1 : 0)}×${options.period}s` : null,
        active: !game.over && game.running === seat,
        low: clock.ms < LOW_TIME_MS && (lastPeriod || clock.byo) && !game.over,
        fill: clock.ms / (clock.byo ? periodMs : start.ms || periodMs),
      });
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
    const { actions } = screen;
    actions.replaceChildren();
    if (game.over || watching()) return;
    const button = (text, action, props) => actionButton(ctx, text, action, props);
    const resign = el('button', {
      textContent: 'Resign',
      className: 'danger',
      onclick: () => {
        if (confirm('Resign this game?')) ctx.send({ action: 'resign' });
      },
    });
    if (game.scoring) {
      const accepted = game.scoring.accepted[game.you];
      actions.append(
        accepted ? el('button', { textContent: 'Accepted', disabled: true }) : button('Accept score', 'acceptScore', { className: 'primary' }),
        button('Resume play', 'resume'),
        resign);
      return;
    }
    actions.append(button('Pass', 'pass', { disabled: game.turn !== game.you }));
    // A move can be asked back once we have made one.
    const moved = replay.states.slice(0, game.played.length).some((state) => state.turn === game.you);
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
function preview(container, position) {
  drawThumbnail(container, { ...position, stars: starPoints(position.size) });
}

export default { inviteForm, botForm, describeOptions, describeResult, preview, settings, mount };

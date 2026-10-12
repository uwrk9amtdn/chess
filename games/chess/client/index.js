// Chess in the browser: the options in the invitation dialog and the game
// screen. All game state comes from the server as snapshots; this file only
// draws them and sends the player's intent. See games/README.md.

import { variants } from '../shared/variants.js';
import {
  createGame, applyMove, inCheck, seatToMove, teamOf, kingSquares, POCKET_TYPES,
} from '../shared/engine.js';
import { createBoard, drawThumbnail, pieceUrl } from './board.js';

const LOW_TIME_MS = 10_000;
const PRESETS = [[1, 0], [2, 1], [3, 0], [3, 2], [5, 0], [5, 3], [10, 0], [10, 5], [15, 10], [30, 0], [30, 20]];
const SETUP_KEY = 'chess.setup';
const CHAT_PHRASES = { GG: 'Good game', WP: 'Well played', TY: 'Thank you', GTG: "I've got to go", BYE: 'Bye!' };
const CHAT_MAX_LENGTH = 140;
const CHAT_KEY = 'chess.chat';
// For the material balance next to the clocks, most valuable first.
const PIECE_VALUES = { q: 9, r: 5, b: 3, n: 3, p: 1 };

const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = new URL('./chess.css', import.meta.url);
document.head.append(stylesheet);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const formatTimeControl = (minutes, increment) => `${minutes}+${increment}`;

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

// "3+1" for standard chess, "3+1 Double 16x16" for anything else.
function describeOptions({ minutes, increment, variant }) {
  const time = formatTimeControl(minutes, increment);
  return variant === 'standard' ? time : `${time} ${variants[variant].name}`;
}

// The names of time controls by how long a game is likely to last: the
// minutes plus forty moves' worth of increment.
function timeCategory(minutes, increment) {
  const seconds = minutes * 60 + 40 * increment;
  if (seconds < 180) return 'Bullet';
  if (seconds < 480) return 'Blitz';
  return seconds < 1500 ? 'Rapid' : 'Classical';
}

// The values the two sliders step through.
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const MINUTES = [...range(1, 20), 25, 30, 35, 40, 45, 60];
const INCREMENTS = [...range(0, 20), 25, 30];

// The variant and time last sent from the game setup are offered again.
function rememberedSetup() {
  const setup = { variant: 'standard', minutes: 5, increment: 3 };
  try {
    const saved = JSON.parse(localStorage.getItem(SETUP_KEY)) || {};
    if (Object.hasOwn(variants, saved.variant)) setup.variant = saved.variant;
    if (MINUTES.includes(saved.minutes)) setup.minutes = saved.minutes;
    if (INCREMENTS.includes(saved.increment)) setup.increment = saved.increment;
  } catch {
    // Nothing usable was saved.
  }
  return setup;
}

function variantIcon(variant) {
  return el('span', {
    className: variant.plainIcon ? 'chessIcon plain' : 'chessIcon',
    textContent: variant.plainIcon ? `${variant.icon}︎` : variant.icon,
  });
}

// First a grid of time controls: clicking one sends an invitation to a game
// of standard chess. "Custom" leads to the game setup, where the variant and
// any time control can be chosen.
function inviteForm(container, submit) {
  const setup = rememberedSetup();

  const tiles = PRESETS.map(([m, i]) => el('button', {
    type: 'button',
    className: 'chessTimeTile',
    onclick: () => submit({ variant: 'standard', minutes: m, increment: i }),
  }, el('strong', { textContent: formatTimeControl(m, i) }), el('span', { textContent: timeCategory(m, i) })));
  const grid = el('div', { className: 'chessTimes' }, ...tiles,
    el('button', { type: 'button', className: 'chessTimeTile', onclick: () => show(true) },
      el('span', { textContent: 'Custom' })));

  // The variant: a button showing the chosen one, which opens the list.
  const picked = el('button', { type: 'button', className: 'chessVariantPick' });
  const list = el('div', { className: 'chessVariants', hidden: true },
    ...Object.values(variants).map((v) => el('button', {
      type: 'button',
      className: 'chessVariant',
      onclick: () => {
        setup.variant = v.id;
        list.hidden = true;
        renderVariant();
      },
    }, variantIcon(v), el('strong', { textContent: v.name }))));
  picked.onclick = () => {
    list.hidden = !list.hidden;
  };
  function renderVariant() {
    const v = variants[setup.variant];
    picked.replaceChildren(variantIcon(v), el('strong', { textContent: v.name }),
      el('span', { className: 'about', textContent: v.description }), el('span', { className: 'caret', textContent: '▾' }));
    [...list.children].forEach((row, i) => row.classList.toggle('selected', Object.keys(variants)[i] === setup.variant));
  }

  // The time: a slider each for the minutes and the increment.
  const slider = (values) => el('input', { type: 'range', min: 0, max: values.length - 1, step: 1 });
  const minutes = slider(MINUTES);
  const increment = slider(INCREMENTS);
  const minutesBadge = el('strong');
  const incrementBadge = el('strong');
  function renderTime() {
    minutes.value = MINUTES.indexOf(setup.minutes);
    increment.value = INCREMENTS.indexOf(setup.increment);
    minutesBadge.textContent = setup.minutes;
    incrementBadge.textContent = setup.increment;
  }
  minutes.oninput = () => {
    setup.minutes = MINUTES[minutes.value];
    renderTime();
  };
  increment.oninput = () => {
    setup.increment = INCREMENTS[increment.value];
    renderTime();
  };
  const chips = el('div', { className: 'chessChips' }, ...PRESETS.map(([m, i]) => el('button', {
    type: 'button',
    textContent: formatTimeControl(m, i),
    onclick: () => {
      Object.assign(setup, { minutes: m, increment: i });
      renderTime();
    },
  })));

  const form = el('div', { className: 'chessSetup', hidden: true },
    el('div', { className: 'chessVariantBox' }, picked, list),
    el('div', { className: 'chessSliders' },
      el('label', {}, 'Minutes per side', minutes),
      el('div', { className: 'chessBadges' }, minutesBadge, '+', incrementBadge),
      el('label', {}, 'Increment in seconds', increment)),
    chips,
    el('div', { className: 'chessSetupActions' },
      el('button', { type: 'button', textContent: '← Back', onclick: () => show(false) }),
      el('button', {
        type: 'button',
        className: 'primary',
        textContent: 'Send invitation',
        onclick: () => {
          try {
            localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
          } catch {
            // Storage can be unavailable; the setup is then not remembered.
          }
          submit({ ...setup });
        },
      })));

  function show(custom) {
    grid.hidden = custom;
    form.hidden = !custom;
    list.hidden = true;
  }
  renderVariant();
  renderTime();
  container.append(grid, form);
}

// How each ending reads, given the colour that lost: "Black resigned".
const ENDINGS = {
  checkmate: () => 'Checkmate',
  resign: (loser) => `${loser} resigned`,
  timeout: () => 'Time out',
  abandoned: (loser) => `${loser} left the game`,
  stalemate: () => 'Stalemate',
  repetition: () => 'Threefold repetition',
  fifty: () => 'Fifty moves without progress',
  material: () => 'Insufficient material',
  agreement: () => 'Mutual agreement',
  // The variants' own endings.
  hill: () => 'King in the centre',
  checks: () => 'Three checks',
  explosion: (loser) => `${loser}'s king exploded`,
  horde: () => 'Horde destroyed',
  goal: () => 'Race finished',
  antichess: () => 'No moves left',
};

// { score: '1-0', how: 'Black resigned', text: 'Black resigned • White is victorious' }
function resultOf(variant, { reason, winner }) {
  if (winner === null) {
    const how = ENDINGS[reason]();
    return { score: '½-½', how, text: `${how} • Draw` };
  }
  const colour = (won) => capitalise(variant.seats.find((s) => (s.team === winner) === won).id);
  const how = ENDINGS[reason](colour(false));
  return { score: winner === 0 ? '1-0' : '0-1', how, text: `${how} • ${colour(true)} is victorious` };
}

// "1-0 • Black resigned", for lists of finished games.
function describeResult({ options, over }) {
  const { score, how } = resultOf(variants[options.variant], over);
  return `${score} • ${how}`;
}

function mount(container, ctx) {
  // What is shown for one player beside the board: top is the opponent.
  const side = () => ({
    material: el('div', { className: 'chessMaterial' }),
    clock: el('div', { className: 'chessClock' }),
    bar: el('div', { className: 'chessBar' }, el('span')),
    player: el('div', { className: 'chessPlayer' },
      el('span', { className: 'dot' }), el('span', { className: 'name' }), el('span', { className: 'checks' })),
    pocket: el('div', { className: 'chessPocket', hidden: true }),
  });
  const top = side();
  const bottom = side();
  const boardEl = el('div', { className: 'chessBoard' });
  const nav = Object.fromEntries(Object.entries(NAV_ICONS).map(([name, path]) => {
    const button = el('button', { type: 'button', title: `${capitalise(name)} move` }, icon(path));
    return [name, button];
  }));
  const movesEl = el('div', { className: 'chessMoves' });
  const statusEl = el('div', { className: 'chessStatus' });
  const actionsEl = el('div', { className: 'chessActions' });

  const timeEl = el('div', { className: 'chessTime' });
  const namesEl = el('div', { className: 'chessNames' });
  const watchersEl = el('div', { className: 'chessWatchers' });
  const resultEl = el('div', { className: 'chessResult' });

  const chatToggle = el('input', { type: 'checkbox', checked: chatEnabled(), title: 'Show the chat' });
  const chatList = el('ul', { className: 'chessChatLog' });
  const chatInput = el('input', {
    maxLength: CHAT_MAX_LENGTH, autocomplete: 'off', placeholder: 'Please be nice in the chat!',
  });
  const chatForm = el('form', {}, chatInput);
  const chatQuick = el('div', { className: 'chessChatQuick' },
    ...Object.entries(CHAT_PHRASES).map(([short, phrase]) => el('button', {
      type: 'button',
      textContent: short,
      title: phrase,
      onclick: () => ctx.sendChat(phrase),
    })));
  const chatBody = el('div', { className: 'chessChatBody' }, chatList, chatForm, chatQuick);
  const chatCard = el('div', { className: 'chessCard chessChat' },
    el('label', { className: 'chessChatHead' }, 'Chat room', chatToggle), chatBody);

  const promotionChoices = el('div');
  const promotionDialog = el('dialog', { className: 'chessPromotion' }, promotionChoices);
  container.replaceChildren(el('div', { className: 'chess' },
    el('div', { className: 'chessSide' },
      el('div', { className: 'chessCard chessInfo' }, timeEl, namesEl, watchersEl, resultEl),
      chatCard),
    el('div', { className: 'chessTable' }, top.pocket, boardEl, bottom.pocket),
    el('div', { className: 'chessControls' },
      top.material, top.clock,
      el('div', { className: 'chessCard chessPanel' },
        top.bar, top.player,
        el('div', { className: 'chessNav' }, nav.first, nav.prev, nav.next, nav.last),
        movesEl, statusEl, actionsEl,
        bottom.player, bottom.bar),
      bottom.clock, bottom.material),
    promotionDialog));

  let game = null; // latest snapshot from the server
  let gameAt = 0; // performance.now() when it arrived, for ticking the clock
  let lowTimeWarned = null; // id of the game we already beeped for
  let viewPly = null; // the earlier position being looked at, or null for the latest
  let replay = { id: null, states: [] }; // the position after each move of one game
  let shown = { id: null, ply: 0 }; // what the board showed last
  let chatMessages = [];
  let inHand = null; // the pocket piece picked up to be dropped

  const board = createBoard(boardEl, {
    onMove: (move) => ctx.send({ action: 'move', ...move }),
    choosePromotion,
    onDropSelected: (type) => {
      inHand = type;
      for (const slot of bottom.pocket.children) slot.classList.toggle('selected', slot.dataset.type === type);
    },
  });

  function choosePromotion(types, seat) {
    return new Promise((resolve) => {
      let choice = null;
      promotionChoices.replaceChildren(...types.map((type) => {
        const button = el('button', {
          title: type.toUpperCase(),
          onclick: () => {
            choice = type;
            promotionDialog.close();
          },
        });
        button.style.backgroundImage = `url("${pieceUrl(type, seat)}")`;
        return button;
      }));
      promotionDialog.addEventListener('close', () => resolve(choice), { once: true });
      promotionDialog.showModal();
    });
  }

  // Plays the sounds for whatever changed between two snapshots of one game.
  function announce(prev, next) {
    const same = Boolean(prev && prev.id === next.id);
    if (same && next.moves.length > prev.moves.length) {
      const san = next.moves[next.moves.length - 1];
      // Every capture is an explosion where captures explode.
      if (!san.includes('x')) ctx.play('move');
      else ctx.play(variants[next.variant].explosions ? 'explosion' : 'capture');
    }
    if (same && next.over && !prev.over) ctx.play('end', 0.3);
    const offered = (g) => g.you !== null && g.drawOffer !== null && g.drawOffer !== g.you;
    if (offered(next) && !(same && offered(prev))) ctx.play('notify');
  }

  // Our own seat is at the bottom; a spectator (`you` is null) sits behind the
  // first seat. Two players for now, so the other seat is at the top.
  const watching = () => game.you === null;
  const bottomSeat = () => game.you ?? 0;
  const topSeat = () => game.players.findIndex((_, seat) => seat !== bottomSeat());

  // The server sends the moves; replaying them gives every position of the
  // game, which is what lets the player step back through it.
  function positions(variant) {
    if (replay.id !== game.id) replay = { id: game.id, states: [createGame(variant, game.start ?? undefined)] };
    const { states } = replay;
    for (let i = states.length - 1; i < game.played.length; i++) states.push(applyMove(states[i], game.played[i]));
    return states;
  }

  // Looks at the position after `ply` moves without changing the game.
  function go(ply) {
    const total = game.played.length;
    const clamped = Math.max(0, Math.min(total, ply));
    viewPly = clamped === total ? null : clamped;
    render();
  }
  nav.first.onclick = () => go(0);
  nav.prev.onclick = () => go((viewPly ?? game.played.length) - 1);
  nav.next.onclick = () => go((viewPly ?? game.played.length) + 1);
  nav.last.onclick = () => go(game.played.length);

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

  function statusText(variant, mover) {
    if (game.drawOffer !== null && game.drawOffer !== game.you) return `${game.players[game.drawOffer]} offers a draw`;
    if (watching()) return `${capitalise(variant.seats[mover].id)} to move`;
    return mover === game.you ? 'Your move' : `Waiting for ${game.players[mover]}`;
  }

  function render() {
    const variant = variants[game.variant];
    const states = positions(variant);
    const total = game.played.length;
    const ply = viewPly ?? total;
    const state = states[ply];
    const mover = seatToMove(states[total]);
    const live = !game.over;
    const team = teamOf(variant, seatToMove(state));

    let mode = 'none';
    if (live && ply === total && !watching()) mode = mover === game.you ? 'move' : 'premove';
    board.update({
      state,
      seat: bottomSeat(),
      lastMove: ply ? game.played[ply - 1] : null,
      checked: inCheck(state, team) ? kingSquares(state, team) : [],
      marked: markedSquares(variant),
      mode,
      // One step forward or back slides; a longer jump just appears.
      animate: shown.id === game.id && Math.abs(ply - shown.ply) <= 1,
    });
    shown = { id: game.id, ply };

    for (const [where, seat] of [[top, topSeat()], [bottom, bottomSeat()]]) {
      // Who is still connected says nothing once the game is over.
      where.player.querySelector('.dot').className = `dot ${game.connected[seat] ? 'online' : 'offline'}`;
      where.player.querySelector('.dot').hidden = !live;
      where.player.querySelector('.name').textContent = game.players[seat];
      where.player.querySelector('.checks').textContent = state.checks
        ? `${state.checks[teamOf(variant, seat)]} of ${variant.checkLimit} checks` : '';
      where.clock.classList.toggle('active', live && mover === seat);
      where.clock.dataset.clock = variant.seats[seat].clock;
    }
    renderMaterial(state);
    renderPockets(state, mode);

    let about = `${formatTimeControl(game.options.minutes, game.options.increment)} • ${variant.name}`;
    if (variant.starts) about += ` • Position ${game.start}`;
    timeEl.replaceChildren(variantIcon(variant), about);
    namesEl.replaceChildren(...game.players.map((name, seat) => el('div', {},
      el('span', { className: `swatch seat${seat}` }), name)));
    watchersEl.hidden = !game.spectators || !live;
    watchersEl.textContent = `${game.spectators} watching`;
    chatCard.hidden = watching();
    const result = game.over && resultOf(variant, game.over);
    resultEl.hidden = !result;
    resultEl.textContent = result ? result.text : '';
    if (result) {
      statusEl.replaceChildren(el('strong', { textContent: result.score }), el('em', { textContent: result.text }));
    } else statusEl.textContent = statusText(variant, mover);
    statusEl.classList.toggle('over', !live);

    // One row per round: its number, then a move for each seat in turn order.
    const perRound = variant.turnOrder.length;
    movesEl.style.setProperty('--per-round', perRound);
    const cells = [];
    game.moves.forEach((san, i) => {
      if (i % perRound === 0) cells.push(el('span', { className: 'index', textContent: i / perRound + 1 }));
      cells.push(el('button', {
        type: 'button',
        className: i + 1 === ply ? 'active' : '',
        textContent: san,
        onclick: () => go(i + 1),
      }));
    });
    movesEl.replaceChildren(...cells);
    // Scroll only as far as needed to keep the move being shown in sight.
    const active = movesEl.querySelector('.active');
    if (!active) movesEl.scrollTop = 0;
    else {
      const bottom = active.offsetTop + active.offsetHeight;
      movesEl.scrollTop = Math.max(bottom - movesEl.clientHeight, Math.min(movesEl.scrollTop, active.offsetTop));
    }
    nav.first.disabled = nav.prev.disabled = ply === 0;
    nav.next.disabled = nav.last.disabled = ply === total;

    updateClocks();
    renderActions();
  }

  // The squares a king wins by reaching, where the variant has such squares.
  function markedSquares(variant) {
    if (variant.hill) return variant.hill;
    if (variant.goalRank === undefined) return [];
    return Array.from({ length: variant.width }, (_, x) => variant.goalRank * variant.width + x);
  }

  // The captured pieces each player may put back on the board, above and
  // below it. Our own are picked up with a click or dragged onto a square.
  function renderPockets(state, mode) {
    for (const [where, seat] of [[top, topSeat()], [bottom, bottomSeat()]]) {
      where.pocket.hidden = !state.pockets;
      if (!state.pockets) continue;
      const mine = where === bottom && mode === 'move';
      where.pocket.replaceChildren(...POCKET_TYPES.map((type) => {
        const count = state.pockets[seat][type] || 0;
        const slot = el('button', { type: 'button', className: 'slot', disabled: !mine || !count });
        slot.dataset.type = type;
        slot.dataset.count = count;
        slot.classList.toggle('empty', !count);
        slot.classList.toggle('selected', mine && inHand === type);
        slot.style.backgroundImage = `url("${pieceUrl(type, seat)}")`;
        slot.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          board.startDrop(type, e);
        });
        return slot;
      }));
    }
  }

  // Beside each clock: the pieces that player has more of, and their lead.
  // It means little where captured pieces come back.
  function renderMaterial(state) {
    top.material.hidden = bottom.material.hidden = Boolean(state.pockets);
    const counts = game.players.map(() => ({}));
    for (const p of state.board) if (p) counts[p.seat][p.type] = (counts[p.seat][p.type] || 0) + 1;
    for (const [where, seat, rival] of [[top, topSeat(), bottomSeat()], [bottom, bottomSeat(), topSeat()]]) {
      const parts = [];
      let lead = 0;
      for (const [type, value] of Object.entries(PIECE_VALUES)) {
        const extra = (counts[seat][type] || 0) - (counts[rival][type] || 0);
        lead += extra * value;
        for (let i = 0; i < extra; i++) {
          const piece = el('span', { className: 'piece' });
          piece.style.backgroundImage = `url("${pieceUrl(type, 1)}")`;
          parts.push(piece);
        }
      }
      if (lead > 0) parts.push(`+${lead}`);
      where.material.replaceChildren(...parts);
    }
  }

  // The server sends the clocks as of the snapshot; between snapshots the
  // running one is counted down locally. An earlier position is shown with
  // the time the players had left when it was reached.
  function updateClocks() {
    if (!game) return;
    const elapsed = performance.now() - gameAt;
    const then = viewPly === null ? null : game.clockHistory?.[viewPly - 1];
    for (const where of [top, bottom]) {
      const clock = Number(where.clock.dataset.clock);
      let ms = Math.max(0, game.clocks[clock] - (game.running === clock ? elapsed : 0));
      if (then) ms = then[clock];
      else if (viewPly === 0) ms = game.initialMs;
      where.clock.textContent = formatClock(ms);
      where.clock.classList.toggle('low', ms < LOW_TIME_MS && !game.over);
      where.bar.firstChild.style.width = `${Math.min(100, (ms / game.initialMs) * 100)}%`;
    }
    // One warning when our own clock first drops into the last seconds.
    const mine = Number(bottom.clock.dataset.clock);
    if (!watching() && game.running === mine && lowTimeWarned !== game.id && game.clocks[mine] - elapsed < LOW_TIME_MS) {
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
    if (game.drawOffer === null) actionsEl.append(button('Offer draw', 'offerDraw'));
    else if (game.drawOffer === game.you) actionsEl.append(el('button', { textContent: 'Draw offered', disabled: true }));
    else actionsEl.append(button('Accept draw', 'acceptDraw', { className: 'primary' }), button('Decline', 'declineDraw'));
    actionsEl.append(el('button', {
      textContent: 'Resign',
      className: 'danger',
      onclick: () => {
        if (confirm('Resign this game?')) ctx.send({ action: 'resign' });
      },
    }));
  }

  function renderChat() {
    chatBody.hidden = !chatToggle.checked;
    chatList.replaceChildren(...chatMessages.map((m) => el('li', {}, el('strong', { textContent: m.from }), ` ${m.text}`)));
    chatList.scrollTop = chatList.scrollHeight;
  }
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
        if (!sameGame || snapshot.over) board.cancelPremove();
      }
      game = snapshot;
      render();
    },
    chat(messages) {
      // One more message than before is a new one; anything else is the log.
      const added = messages.length === chatMessages.length + 1 ? messages[messages.length - 1] : null;
      chatMessages = messages.slice();
      if (added && chatToggle.checked && game && added.from !== game.players[game.you]) ctx.play('notify');
      renderChat();
    },
    destroy() {
      clearInterval(ticker);
      document.removeEventListener('keydown', onKey);
      container.replaceChildren();
    },
  };
}

// Draws what the server's `preview` describes, for lists of games.
function preview(container, { variant, ...position }) {
  drawThumbnail(container, { variant: variants[variant], ...position });
}

export default { inviteForm, describeOptions, describeResult, preview, mount };

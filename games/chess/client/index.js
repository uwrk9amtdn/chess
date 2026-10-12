// Chess in the browser: the options in the invitation dialog and the game
// screen. All game state comes from the server as snapshots; this file only
// draws them and sends the player's intent. See games/README.md.

import { variants } from '../shared/variants.js';
import { createGame, applyMove, inCheck, seatToMove, teamOf, kingSquares } from '../shared/engine.js';
import { createBoard, pieceUrl } from './board.js';

const LOW_TIME_MS = 10_000;
const PRESETS = [[1, 1], [3, 1], [5, 1]];
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

// The board type, three quick time controls and a custom one.
function inviteForm(container, submit) {
  const variant = el('select', {},
    ...Object.values(variants).map((v) => el('option', { value: v.id, textContent: v.name })));
  const send = (minutes, increment) => submit({ variant: variant.value, minutes, increment });

  const minutes = el('input', { type: 'number', min: 1, max: 60, value: 10, required: true });
  const increment = el('input', { type: 'number', min: 0, max: 30, value: 5, required: true });
  const custom = el('form', { className: 'chessCustom' },
    el('label', {}, 'Minutes ', minutes),
    el('label', {}, 'Increment ', increment),
    el('button', { textContent: 'Send custom' }));
  custom.addEventListener('submit', (e) => {
    e.preventDefault();
    send(minutes.valueAsNumber, increment.valueAsNumber);
  });

  container.append(
    el('label', { className: 'chessField' }, 'Board ', variant),
    el('p', { className: 'hint', textContent: 'Minutes per player + seconds added after each move.' }),
    el('div', { className: 'chessPresets' }, ...PRESETS.map(([m, i]) => el('button', {
      textContent: formatTimeControl(m, i),
      onclick: () => send(m, i),
    }))),
    custom);
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
};

// { score: '1-0', text: 'Black resigned • White is victorious' }
function describeResult(variant, { reason, winner }) {
  if (winner === null) return { score: '½-½', text: `${ENDINGS[reason]()} • Draw` };
  const colour = (won) => capitalise(variant.seats.find((s) => (s.team === winner) === won).id);
  return {
    score: winner === 0 ? '1-0' : '0-1',
    text: `${ENDINGS[reason](colour(false))} • ${colour(true)} is victorious`,
  };
}

function mount(container, ctx) {
  // What is shown for one player beside the board: top is the opponent.
  const side = () => ({
    material: el('div', { className: 'chessMaterial' }),
    clock: el('div', { className: 'chessClock' }),
    bar: el('div', { className: 'chessBar' }, el('span')),
    player: el('div', { className: 'chessPlayer' }, el('span', { className: 'dot' }), el('span', { className: 'name' })),
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

  const promotionChoices = el('div');
  const promotionDialog = el('dialog', { className: 'chessPromotion' }, promotionChoices);
  container.replaceChildren(el('div', { className: 'chess' },
    el('div', { className: 'chessSide' },
      el('div', { className: 'chessCard chessInfo' }, timeEl, namesEl, resultEl),
      el('div', { className: 'chessCard chessChat' },
        el('label', { className: 'chessChatHead' }, 'Chat room', chatToggle), chatBody)),
    el('div', { className: 'chessTable' }, boardEl),
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

  const board = createBoard(boardEl, {
    onMove: (move) => ctx.send({ action: 'move', ...move }),
    choosePromotion,
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
      ctx.play(/[+#]/.test(san) ? 'check' : san.includes('x') ? 'capture' : 'move');
    }
    if (same && next.over && !prev.over) ctx.play('end', 0.3);
    const offered = (g) => g.drawOffer !== null && g.drawOffer !== g.you;
    if (offered(next) && !(same && offered(prev))) ctx.play('notify');
  }

  // Two players for now; the seat that is not ours sits at the top.
  const opponentSeat = () => game.players.findIndex((_, seat) => seat !== game.you);

  // The server sends the moves; replaying them gives every position of the
  // game, which is what lets the player step back through it.
  function positions(variant) {
    if (replay.id !== game.id) replay = { id: game.id, states: [createGame(variant)] };
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

  function statusText(mover) {
    if (game.drawOffer !== null && game.drawOffer !== game.you) return `${game.players[game.drawOffer]} offers a draw`;
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
    if (live && ply === total) mode = mover === game.you ? 'move' : 'premove';
    board.update({
      state,
      seat: game.you,
      lastMove: ply ? game.played[ply - 1] : null,
      checked: inCheck(state, team) ? kingSquares(state, team) : [],
      mode,
      // One step forward or back slides; a longer jump just appears.
      animate: shown.id === game.id && Math.abs(ply - shown.ply) <= 1,
    });
    shown = { id: game.id, ply };

    for (const [where, seat] of [[top, opponentSeat()], [bottom, game.you]]) {
      where.player.querySelector('.dot').className = `dot ${game.connected[seat] ? 'online' : 'offline'}`;
      where.player.querySelector('.name').textContent = game.players[seat];
      where.clock.classList.toggle('active', live && mover === seat);
      where.clock.dataset.clock = variant.seats[seat].clock;
    }
    renderMaterial(state);

    timeEl.textContent = `${formatTimeControl(game.options.minutes, game.options.increment)} • ${variant.name}`;
    namesEl.replaceChildren(...game.players.map((name, seat) => el('div', {},
      el('span', { className: `swatch seat${seat}` }), name)));
    const result = game.over && describeResult(variant, game.over);
    resultEl.hidden = !result;
    resultEl.textContent = result ? result.text : '';
    if (result) {
      statusEl.replaceChildren(el('strong', { textContent: result.score }), el('em', { textContent: result.text }));
    } else statusEl.textContent = statusText(mover);
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

  // Beside each clock: the pieces that player has more of, and their lead.
  function renderMaterial(state) {
    const counts = game.players.map(() => ({}));
    for (const p of state.board) if (p) counts[p.seat][p.type] = (counts[p.seat][p.type] || 0) + 1;
    for (const [where, seat, rival] of [[top, opponentSeat(), game.you], [bottom, game.you, opponentSeat()]]) {
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
  // running one is counted down locally.
  function updateClocks() {
    if (!game) return;
    const elapsed = performance.now() - gameAt;
    for (const where of [top, bottom]) {
      const clock = Number(where.clock.dataset.clock);
      const ms = Math.max(0, game.clocks[clock] - (game.running === clock ? elapsed : 0));
      where.clock.textContent = formatClock(ms);
      where.clock.classList.toggle('low', ms < LOW_TIME_MS && !game.over);
      where.bar.firstChild.style.width = `${Math.min(100, (ms / game.initialMs) * 100)}%`;
    }
    // One warning when our own clock first drops into the last seconds.
    const mine = Number(bottom.clock.dataset.clock);
    if (game.running === mine && lowTimeWarned !== game.id && game.clocks[mine] - elapsed < LOW_TIME_MS) {
      lowTimeWarned = game.id;
      ctx.play('lowTime');
    }
  }
  const ticker = setInterval(updateClocks, 100);

  // Once the game is over the platform offers the rematch.
  function renderActions() {
    actionsEl.replaceChildren();
    if (game.over) return;
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

export default { inviteForm, describeOptions, mount };

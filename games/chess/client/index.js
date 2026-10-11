// Chess in the browser: the options in the invitation dialog and the game
// screen. All game state comes from the server as snapshots; this file only
// draws them and sends the player's intent. See games/README.md.

import { variants } from '../shared/variants.js';
import { deserialize, seatToMove, teamOf, kingSquares } from '../shared/engine.js';
import { createBoard, glyph } from './board.js';

const LOW_TIME_MS = 10_000;
const PRESETS = [[1, 1], [3, 1], [5, 1]];

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

function formatClock(ms) {
  if (ms < LOW_TIME_MS) {
    const tenths = Math.floor(ms / 100);
    return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

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

const DRAWS = {
  stalemate: 'by stalemate',
  repetition: 'by threefold repetition',
  fifty: 'by the 50-move rule',
  material: 'by insufficient material',
  agreement: 'by agreement',
  timeout: 'on time against a bare king',
};
const WINS = {
  checkmate: 'by checkmate',
  resign: 'by resignation',
  timeout: 'on time',
  abandoned: 'by abandonment',
};

function mount(container, ctx) {
  const bar = () => el('div', { className: 'chessPlayer' },
    el('span', { className: 'swatch' }), el('span', { className: 'name' }), el('span', { className: 'clock' }));
  const topBar = bar();
  const bottomBar = bar();
  const boardEl = el('div', { className: 'chessBoard' });
  const timeEl = el('div', { className: 'chessTime' });
  const statusEl = el('div', { className: 'chessStatus' });
  const movesEl = el('ol', { className: 'chessMoves' });
  const actionsEl = el('div', { className: 'chessActions' });
  const promotionChoices = el('div');
  const promotionDialog = el('dialog', { className: 'chessPromotion' }, promotionChoices);
  container.replaceChildren(el('div', { className: 'chess' },
    el('div', { className: 'chessTable' }, topBar, boardEl, bottomBar),
    el('div', { className: 'chessPanel' }, timeEl, statusEl, movesEl, actionsEl),
    promotionDialog));

  let game = null; // latest snapshot from the server
  let gameAt = 0; // performance.now() when it arrived, for ticking the clock
  let lowTimeWarned = null; // id of the game we already beeped for

  const board = createBoard(boardEl, {
    onMove: (move) => ctx.send({ action: 'move', ...move }),
    choosePromotion,
  });

  function choosePromotion(types, seat) {
    return new Promise((resolve) => {
      let choice = null;
      promotionChoices.replaceChildren(...types.map((type) => el('button', {
        className: `piece seat${seat}`,
        textContent: glyph(type),
        onclick: () => {
          choice = type;
          promotionDialog.close();
        },
      })));
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

  function statusText(variant, mover) {
    if (game.over) {
      const { reason, winner } = game.over;
      if (winner === null) return `Draw ${DRAWS[reason]}`;
      return `${winner === teamOf(variant, game.you) ? 'You won' : 'You lost'} ${WINS[reason]}`;
    }
    if (game.drawOffer !== null && game.drawOffer !== game.you) return `${game.players[game.drawOffer]} offers a draw`;
    const turn = mover === game.you ? 'Your move' : `Waiting for ${game.players[mover]}`;
    return game.check ? `${turn} (check)` : turn;
  }

  function render() {
    const variant = variants[game.variant];
    const state = deserialize(game.state, variant);
    const mover = seatToMove(state);
    const live = !game.over;

    board.update({
      state,
      seat: game.you,
      lastMove: game.lastMove,
      checked: game.check ? kingSquares(state, teamOf(variant, mover)) : [],
      interactive: live && mover === game.you,
    });

    for (const [node, seat] of [[topBar, opponentSeat()], [bottomBar, game.you]]) {
      node.querySelector('.swatch').className = `swatch seat${seat}`;
      node.querySelector('.name').textContent = game.players[seat] + (game.connected[seat] ? '' : ' (disconnected)');
      node.classList.toggle('active', live && mover === seat);
      node.dataset.clock = variant.seats[seat].clock;
    }

    timeEl.textContent = `${variant.name} · ${formatTimeControl(game.options.minutes, game.options.increment)}`;
    statusEl.textContent = statusText(variant, mover);
    statusEl.classList.toggle('over', !live);

    // One row per round: a move for each seat in turn order.
    const perRound = variant.turnOrder.length;
    const rows = [];
    for (let i = 0; i < game.moves.length; i += perRound) {
      rows.push(el('li', {}, ...game.moves.slice(i, i + perRound).map((san) => el('span', { textContent: san }))));
    }
    movesEl.replaceChildren(...rows);
    movesEl.scrollTop = movesEl.scrollHeight;

    updateClocks();
    renderActions();
  }

  // The server sends the clocks as of the snapshot; between snapshots the
  // running one is counted down locally.
  function updateClocks() {
    if (!game) return;
    const elapsed = performance.now() - gameAt;
    for (const node of [topBar, bottomBar]) {
      const clock = Number(node.dataset.clock);
      const ms = Math.max(0, game.clocks[clock] - (game.running === clock ? elapsed : 0));
      const face = node.querySelector('.clock');
      face.textContent = formatClock(ms);
      face.classList.toggle('low', ms < LOW_TIME_MS && !game.over);
    }
    // One warning when our own clock first drops into the last seconds.
    const mine = Number(bottomBar.dataset.clock);
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

  return {
    update(snapshot) {
      // The same snapshot again means "redraw", e.g. after a refused move.
      if (snapshot !== game) {
        announce(game, snapshot);
        gameAt = performance.now();
      }
      game = snapshot;
      render();
    },
    destroy() {
      clearInterval(ticker);
      container.replaceChildren();
    },
  };
}

export default { inviteForm, describeOptions, mount };

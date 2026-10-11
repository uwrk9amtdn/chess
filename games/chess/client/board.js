// Draws a position and turns clicks and drags into moves. The grid is sized
// from the variant, so any board width and height works.

import { legalMoves, applyMove, squareName } from '../shared/engine.js';

// The filled glyphs are used for every seat; CSS colours them per seat.
// U+FE0E asks for the text form so platforms do not substitute emoji.
const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
export const glyph = (type) => GLYPHS[type] + '︎';

const DRAG_THRESHOLD_PX = 5;

// `onMove({ from, to, promotion })` is called when the player makes a move.
// `choosePromotion(types, seat)` resolves to the chosen piece type, or null.
export function createBoard(root, { onMove, choosePromotion }) {
  let view = null; // { state, seat, lastMove, checked, interactive }
  let selected = null;
  let targets = [];
  let drag = null;

  function render() {
    const { state, seat, lastMove, checked, interactive } = view;
    const { width: w, height: h, seats } = state.variant;
    // Each player sees their own army at the bottom.
    const flipped = seats[seat].forward[1] < 0;
    root.style.setProperty('--cols', w);
    root.style.setProperty('--rows', h);
    root.classList.toggle('interactive', interactive);

    const squares = [];
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const x = flipped ? w - 1 - col : col;
        const y = flipped ? row : h - 1 - row;
        const idx = y * w + x;
        const piece = state.board[idx];
        const sq = document.createElement('div');
        sq.className = `sq ${(x + y) % 2 ? 'light' : 'dark'}`;
        sq.dataset.idx = idx;
        if (lastMove && (lastMove.from === idx || lastMove.to === idx)) sq.classList.add('last');
        if (idx === selected) sq.classList.add('selected');
        if (checked.includes(idx)) sq.classList.add('check');
        const target = targets.find((m) => m.to === idx);
        if (target) sq.classList.add(target.capture !== undefined ? 'capture' : 'target');

        const name = squareName(state.variant, idx);
        if (col === 0) sq.append(label('rank', name.slice(1)));
        if (row === h - 1) sq.append(label('file', name[0]));
        if (piece) {
          const span = document.createElement('span');
          span.className = `piece seat${piece.seat}`;
          span.textContent = glyph(piece.type);
          sq.append(span);
        }
        squares.push(sq);
      }
    }
    root.replaceChildren(...squares);
  }

  function label(kind, text) {
    const span = document.createElement('span');
    span.className = `coord ${kind}`;
    span.textContent = text;
    return span;
  }

  function select(idx) {
    selected = idx;
    targets = idx === null ? [] : legalMoves(view.state, idx);
    render();
  }

  async function tryMove(to) {
    const from = selected;
    const options = targets.filter((m) => m.to === to);
    const shown = view;
    select(null);
    let promotion = options[0].promotion;
    if (options.length > 1) {
      promotion = await choosePromotion(options.map((m) => m.promotion), shown.seat);
      if (!promotion || view !== shown) return;
    }
    // Show the move straight away; the server's next update replaces this.
    const move = { from, to, promotion };
    view = { ...shown, state: applyMove(shown.state, move), lastMove: { from, to }, checked: [], interactive: false };
    render();
    onMove(move);
  }

  root.addEventListener('pointerdown', (e) => {
    if (!view || !view.interactive || e.button !== 0) return;
    const sq = e.target.closest('.sq');
    if (!sq) return;
    const idx = Number(sq.dataset.idx);
    if (selected !== null && targets.some((m) => m.to === idx)) {
      tryMove(idx);
      return;
    }
    const piece = view.state.board[idx];
    if (!piece || piece.seat !== view.seat) {
      select(null);
      return;
    }
    select(idx);
    drag = {
      id: e.pointerId,
      piece: root.querySelector(`.sq[data-idx="${idx}"] .piece`),
      x: e.clientX,
      y: e.clientY,
      moved: false,
    };
    root.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  root.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    drag.piece.classList.add('dragging');
    drag.piece.style.transform = `translate(${dx}px, ${dy}px) scale(1.15)`;
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved } = drag;
    drag = null;
    // A press without movement is a click: the piece just stays selected.
    if (!moved) return;
    const sq = e.type === 'pointerup' && document.elementFromPoint(e.clientX, e.clientY)?.closest('.sq');
    const idx = sq && root.contains(sq) ? Number(sq.dataset.idx) : null;
    if (idx !== null && targets.some((m) => m.to === idx)) tryMove(idx);
    else render();
  }
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  return {
    update(next) {
      view = next;
      selected = null;
      targets = [];
      drag = null;
      render();
    },
  };
}

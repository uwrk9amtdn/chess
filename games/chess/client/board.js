// Draws a position and turns clicks and drags into moves. The grid is sized
// from the variant, so any board width and height works.
//
// The squares and the pieces are separate layers. A piece keeps its element
// from one position to the next, so moving it is a change of `transform` that
// CSS animates. Arrows drawn with the right button go on a third layer above.

import { legalMoves, legalDrops, premoveTargets, playPremove, applyMove, squareName } from '../shared/engine.js';
import { pieceImage } from './theme.js';

const DRAG_THRESHOLD_PX = 5;
const FADE_MS = 200;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Arrows and marked squares, as on chess.com: Shift, Ctrl and Alt pick the
// colour. In squares, the shaft's width and the head's length and width.
const MARK_COLOURS = { orange: '#ffaa00', red: '#eb6150', green: '#9fcf3f', blue: '#52b0dc' };
const SHAFT = 0.22;
const HEAD_LENGTH = 0.45;
const HEAD_WIDTH = 0.6;
// How far from the middle of its first square an arrow starts.
const TAIL_GAP = 0.35;

function markColour(e, square) {
  if (e.shiftKey) return 'green';
  if (e.ctrlKey || e.metaKey) return 'red';
  if (e.altKey) return 'blue';
  return square ? 'red' : 'orange';
}

function svg(tag, attributes) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function samePiece(a, b) {
  return a === b || Boolean(a && b && a.type === b.type && a.seat === b.seat);
}

function div(className) {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

// A small board that only shows a position, seen from the first seat's side.
// `pieces` holds "q1" (type and seat) or "" per square.
export function drawThumbnail(root, { variant, pieces, lastMove, checked }) {
  const { width: w, height: h } = variant;
  root.classList.add('chessThumb');
  root.style.setProperty('--cols', w);
  root.style.setProperty('--rows', h);
  const squares = [];
  for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const sq = div(`sq ${(x + y) % 2 ? 'light' : 'dark'}`);
      if (lastMove && (lastMove.from === idx || lastMove.to === idx)) sq.classList.add('last');
      if (checked.includes(idx)) sq.classList.add('check');
      if (pieces[idx]) sq.style.backgroundImage = pieceImage(pieces[idx][0], Number(pieces[idx].slice(1)));
      squares.push(sq);
    }
  }
  root.replaceChildren(...squares);
}

// `onMove({ from, to, promotion })` is called when the player makes a move;
// putting a piece back from the pocket is `onMove({ drop, to })`.
// `choosePromotion(types, seat)` resolves to the chosen piece type, or null.
// `onDropSelected(type)` says which pocket piece is in hand, or null.
export function createBoard(root, { onMove, choosePromotion, onDropSelected = () => {} }) {
  const squaresEl = div('chessSquares');
  const piecesEl = div('chessPieces');
  const marksEl = svg('svg', { class: 'chessMarks', 'aria-hidden': 'true' });
  root.replaceChildren(squaresEl, piecesEl, marksEl);

  // { state, seat, lastMove, checked, marked, mode, animate }. `mode` is
  // 'move' on the player's turn, 'premove' while waiting for it and 'none'
  // when the board is only for looking at. `marked` lists squares that matter
  // in the variant, such as the ones a king wins by reaching.
  let view = null;
  let layout = ''; // size and orientation the squares were built for
  let flipped = false;
  let squares = []; // square elements by board index
  const pieces = new Map(); // board index -> { el, type, seat }
  let selected = null;
  let targets = [];
  let drag = null;
  // Moves queued while waiting for the player's turn, as { from, to }, in
  // the order they are to be played. `seen` is the position with them made,
  // which is what the board shows and what further premoves start from.
  let premoves = [];
  let seen = null;
  // Arrows ({ from, to, colour }) and marked squares (the same, with `from`
  // and `to` equal), and the one being drawn: { id, from, to, colour }.
  let marks = [];
  let drawing = null;
  let dropType = null; // the pocket piece about to be put on the board
  let ghost = null; // a pocket piece being dragged: { id, el, x, y, moved }

  // Column and row on screen of a board index.
  function cell(idx) {
    const { width: w, height: h } = view.state.variant;
    const x = idx % w;
    const y = (idx - x) / w;
    return flipped ? [w - 1 - x, y] : [x, h - 1 - y];
  }

  function buildSquares() {
    const { width: w, height: h, seats } = view.state.variant;
    // Each player sees their own army at the bottom, unless the variant has
    // everyone look from the same side.
    flipped = !view.state.variant.fixedView && seats[view.seat].forward[1] < 0;
    const key = `${w}x${h}:${flipped}`;
    if (key === layout) return;
    layout = key;
    root.style.setProperty('--cols', w);
    root.style.setProperty('--rows', h);
    marksEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
    squares = new Array(w * h);
    const ordered = [];
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const x = flipped ? w - 1 - col : col;
        const y = flipped ? row : h - 1 - row;
        const idx = y * w + x;
        const sq = div('sq');
        sq.dataset.idx = idx;
        sq.dataset.shade = (x + y) % 2 ? 'light' : 'dark';
        const name = squareName(view.state.variant, idx);
        if (col === w - 1) sq.append(label('rank', name.slice(1)));
        if (row === h - 1) sq.append(label('file', name[0]));
        squares[idx] = sq;
        ordered.push(sq);
      }
    }
    squaresEl.replaceChildren(...ordered);
    // Every piece is drawn afresh on a board of a different shape.
    piecesEl.replaceChildren();
    pieces.clear();
  }

  function label(kind, text) {
    const span = document.createElement('span');
    span.className = `coord ${kind}`;
    span.textContent = text;
    return span;
  }

  // Highlights only; the pieces are handled by syncPieces.
  function paint() {
    const { seat, lastMove, checked, marked = [], mode } = view;
    root.classList.toggle('interactive', mode !== 'none');
    root.classList.toggle('premoving', mode === 'premove');
    squares.forEach((sq, idx) => {
      const classes = ['sq', sq.dataset.shade];
      if (marked.includes(idx)) classes.push('marked');
      if (lastMove && (lastMove.from === idx || lastMove.to === idx)) classes.push('last');
      if (idx === selected) classes.push('selected');
      if (checked.includes(idx)) classes.push('check');
      if (premoves.some((m) => m.from === idx || m.to === idx)) classes.push('premove');
      const target = targets.find((m) => m.to === idx);
      if (target) classes.push(target.capture !== undefined ? 'capture' : 'target');
      if (seen.board[idx]?.seat === seat) classes.push('own');
      sq.className = classes.join(' ');
      const mark = marks.find((m) => m.from === idx && m.to === idx);
      if (mark) sq.dataset.mark = mark.colour;
      else delete sq.dataset.mark;
    });
    drawArrows();
  }

  // The arrows, and the one being drawn. An arrow starts a little way out of
  // the middle of its first square, towards where it goes, and its point
  // reaches the middle of the last; a knight's move bends, going the long way
  // first.
  function drawArrows() {
    const all = marks.filter((m) => m.from !== m.to);
    if (drawing && drawing.from !== drawing.to) all.push(drawing);
    marksEl.replaceChildren(...all.map(({ from, to, colour }) => {
      const [x1, y1] = cell(from).map((c) => c + 0.5);
      const [x2, y2] = cell(to).map((c) => c + 0.5);
      const dx = Math.abs(x2 - x1);
      const dy = Math.abs(y2 - y1);
      const bend = dx * dy === 2 ? [dx > dy ? [x2, y1] : [x1, y2]] : [];
      const [nx, ny] = bend[0] ?? [x2, y2];
      const first = Math.hypot(nx - x1, ny - y1);
      const points = [[x1 + ((nx - x1) / first) * TAIL_GAP, y1 + ((ny - y1) / first) * TAIL_GAP], ...bend];
      const [px, py] = points[points.length - 1];
      const length = Math.hypot(x2 - px, y2 - py);
      const ux = (x2 - px) / length;
      const uy = (y2 - py) / length;
      const bx = x2 - ux * HEAD_LENGTH;
      const by = y2 - uy * HEAD_LENGTH;
      points.push([bx, by]);
      const side = HEAD_WIDTH / 2;
      // As a group, so that where shaft and head meet is not drawn darker.
      const g = svg('g', { opacity: 0.8, fill: MARK_COLOURS[colour] });
      g.append(
        svg('polyline', {
          points: points.join(' '), fill: 'none', stroke: MARK_COLOURS[colour], 'stroke-width': SHAFT,
        }),
        svg('polygon', { points: [[x2, y2], [bx - uy * side, by + ux * side], [bx + uy * side, by - ux * side]].join(' ') }),
      );
      return g;
    }));
  }

  // The board index under a point on the screen, or null.
  function squareAt(clientX, clientY) {
    const { width: w, height: h } = view.state.variant;
    const r = squaresEl.getBoundingClientRect();
    const col = Math.floor(((clientX - r.left) / r.width) * w);
    const row = Math.floor(((clientY - r.top) / r.height) * h);
    if (col < 0 || row < 0 || col >= w || row >= h) return null;
    return flipped ? row * w + w - 1 - col : (h - 1 - row) * w + col;
  }

  // Works out `seen`. A queued move whose piece is no longer there, taken
  // say, is dropped with all those after it.
  function refresh() {
    seen = view.state;
    if (view.mode !== 'premove') return;
    for (let i = 0; i < premoves.length; i++) {
      if (seen.board[premoves[i].from]?.seat !== view.seat) {
        premoves.length = i;
        break;
      }
      seen = playPremove(seen, premoves[i]);
    }
  }

  function clearPremoves() {
    if (!premoves.length) return;
    premoves = [];
    refresh();
    syncPieces(true);
  }

  function setTransform(el, idx) {
    const [col, row] = cell(idx);
    el.style.transform = `translate(${col * 100}%, ${row * 100}%)`;
  }

  // Makes the piece elements match the position. A piece that left one square
  // while one like it appeared on another is the same element sliding over.
  function syncPieces(animate) {
    const { board } = seen;
    const lastMove = (view.mode === 'premove' && premoves[premoves.length - 1]) || view.lastMove;
    const fresh = [];
    const next = new Map();
    board.forEach((p, idx) => {
      if (!p) return;
      const old = pieces.get(idx);
      if (old && old.type === p.type && old.seat === p.seat) {
        next.set(idx, old);
        pieces.delete(idx);
        old.el.classList.remove('moving');
      } else fresh.push(idx);
    });

    // What is left in `pieces` has gone from its square.
    const still = [];
    for (const idx of fresh) {
      const p = board[idx];
      const [col, row] = cell(idx);
      let from = null;
      let nearest = Infinity;
      for (const [at, old] of pieces) {
        if (old.type !== p.type || old.seat !== p.seat) continue;
        const [c, r] = cell(at);
        const distance = Math.hypot(c - col, r - row);
        if (distance < nearest) {
          nearest = distance;
          from = at;
        }
      }
      // A promoting pawn arrives as another piece.
      if (from === null && lastMove && lastMove.to === idx && pieces.get(lastMove.from)?.seat === p.seat) {
        from = lastMove.from;
      }

      let entry;
      if (from !== null) {
        entry = pieces.get(from);
        pieces.delete(from);
        entry.el.classList.add('moving');
      } else {
        entry = { el: div('piece') };
        piecesEl.append(entry.el);
      }
      if (entry.type !== p.type || entry.seat !== p.seat) {
        entry.el.style.backgroundImage = pieceImage(p.type, p.seat);
      }
      entry.type = p.type;
      entry.seat = p.seat;
      entry.el.classList.remove('dragging');
      if (!animate || from === null) {
        entry.el.classList.add('still');
        still.push(entry.el);
      }
      setTransform(entry.el, idx);
      next.set(idx, entry);
    }

    for (const { el } of pieces.values()) {
      if (animate) {
        el.classList.add('gone');
        setTimeout(() => el.remove(), FADE_MS);
      } else el.remove();
    }
    pieces.clear();
    for (const [idx, entry] of next) pieces.set(idx, entry);

    // Pieces placed without animation get their transition back once the
    // browser has taken note of where they are.
    if (still.length) {
      root.getBoundingClientRect();
      for (const el of still) el.classList.remove('still');
    }
  }

  function movesFrom(idx) {
    if (view.mode === 'move') return legalMoves(view.state, idx);
    // Not onto a piece of the player's own, which is still there by then.
    const { board } = seen;
    return premoveTargets(seen, idx)
      .filter((to) => board[to]?.seat !== view.seat)
      .map((to) => ({ to, capture: board[to] ? to : undefined }));
  }

  function setDrop(type) {
    if (dropType === type) return;
    dropType = type;
    onDropSelected(type);
  }

  function select(idx) {
    setDrop(null);
    selected = idx;
    targets = idx === null ? [] : movesFrom(idx);
    paint();
  }

  // Puts a piece that was being dragged back on its square.
  function dropDrag(animate) {
    if (!drag) return;
    const { el, idx, moved } = drag;
    drag = null;
    if (!moved || pieces.get(idx)?.el !== el) return;
    el.classList.remove('dragging');
    if (!animate) el.classList.add('still');
    setTransform(el, idx);
    if (!animate) {
      root.getBoundingClientRect();
      el.classList.remove('still');
    }
  }

  // Shows the move straight away; the server's next update replaces this.
  // From here on the player is waiting again, so they may premove.
  function playLocal(move, animate) {
    view = {
      ...view,
      state: applyMove(view.state, move),
      lastMove: { from: move.from, to: move.to },
      checked: [],
      mode: 'premove',
    };
    marks = [];
    refresh();
    syncPieces(animate);
    paint();
    onMove(move);
  }

  // `dropped` says the piece was dragged there, so it must not slide as well.
  async function choose(to, dropped) {
    const from = selected;
    const options = targets.filter((m) => m.to === to);
    const shown = view;
    drag = null;
    selected = null;
    targets = [];
    if (shown.mode === 'premove') {
      premoves.push({ from, to });
      refresh();
      syncPieces(!dropped);
      paint();
      return;
    }
    let promotion = options[0].promotion;
    if (options.length > 1) {
      paint();
      promotion = await choosePromotion(options.map((m) => m.promotion), shown.seat);
      if (view !== shown) return;
      if (!promotion) {
        const entry = pieces.get(from);
        entry.el.classList.remove('dragging');
        setTransform(entry.el, from);
        return;
      }
    }
    playLocal({ from, to, promotion }, !dropped);
  }

  function playDrop(to) {
    const move = { drop: dropType, to };
    setDrop(null);
    targets = [];
    playLocal(move, false);
  }

  // A pocket piece follows the pointer until it is let go: over a square it
  // may go on, it is dropped there.
  function moveGhost(e) {
    if (!ghost || e.pointerId !== ghost.id) return;
    if (!ghost.moved && Math.hypot(e.clientX - ghost.x, e.clientY - ghost.y) < DRAG_THRESHOLD_PX) return;
    if (!ghost.moved) {
      ghost.moved = true;
      const size = squares[0].getBoundingClientRect().width;
      ghost.el.style.width = ghost.el.style.height = `${size}px`;
      document.body.append(ghost.el);
    }
    ghost.el.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%) scale(1.15)`;
  }

  function endGhost(e) {
    if (!ghost || e.pointerId !== ghost.id) return;
    const { moved, el } = ghost;
    ghost = null;
    el.remove();
    window.removeEventListener('pointermove', moveGhost);
    window.removeEventListener('pointerup', endGhost);
    window.removeEventListener('pointercancel', endGhost);
    // A press without movement is a click: the piece stays in hand.
    if (!moved || dropType === null) return;
    const sq = e.type === 'pointerup' && document.elementFromPoint(e.clientX, e.clientY)?.closest('.sq');
    const idx = sq && root.contains(sq) ? Number(sq.dataset.idx) : null;
    if (idx !== null && targets.some((m) => m.to === idx)) playDrop(idx);
  }

  root.addEventListener('pointerdown', (e) => {
    if (!view) return;
    if (e.button === 2) {
      startMark(e);
      return;
    }
    if (e.button !== 0) return;
    // A click clears the arrows.
    if (marks.length) {
      marks = [];
      paint();
    }
    if (view.mode === 'none') return;
    const sq = e.target.closest('.sq');
    if (!sq) return;
    const idx = Number(sq.dataset.idx);
    if (dropType !== null && targets.some((m) => m.to === idx)) {
      playDrop(idx);
      return;
    }
    if (selected !== null && targets.some((m) => m.to === idx)) {
      choose(idx, false);
      return;
    }
    // Any other click on the board takes back the premoves, unless it is on
    // a piece to queue another one with.
    const piece = seen.board[idx];
    if (!piece || piece.seat !== view.seat) {
      clearPremoves();
      select(null);
      return;
    }
    // A piece pressed again may still be dragged; let go where it was, it is put down.
    const again = idx === selected;
    if (!again) select(idx);
    drag = { id: e.pointerId, el: pieces.get(idx).el, idx, x: e.clientX, y: e.clientY, moved: false, again };
    root.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  // The right button first takes back premoves and anything in hand. With
  // nothing to take back, it draws: let go on the square it was pressed on,
  // that square is marked, elsewhere an arrow goes there. The same mark or
  // arrow again takes it away.
  function startMark(e) {
    if (premoves.length || selected !== null || dropType !== null || drag) {
      dropDrag(true);
      clearPremoves();
      select(null);
      return;
    }
    // Phones have no right button; a pen's may draw.
    if (e.pointerType === 'touch') return;
    const idx = squareAt(e.clientX, e.clientY);
    if (idx === null) return;
    drawing = { id: e.pointerId, from: idx, to: idx, colour: markColour(e, false) };
    root.setPointerCapture(e.pointerId);
  }

  function moveMark(e) {
    const idx = squareAt(e.clientX, e.clientY);
    const colour = markColour(e, false);
    if (idx === null || (idx === drawing.to && colour === drawing.colour)) return;
    drawing.to = idx;
    drawing.colour = colour;
    drawArrows();
  }

  function endMark(e) {
    const { from } = drawing;
    drawing = null;
    const to = e.type === 'pointerup' ? squareAt(e.clientX, e.clientY) : null;
    if (to !== null) {
      const colour = markColour(e, from === to);
      const i = marks.findIndex((m) => m.from === from && m.to === to);
      const same = i >= 0 && marks[i].colour === colour;
      if (i >= 0) marks.splice(i, 1);
      if (!same) marks.push({ from, to, colour });
    }
    paint();
  }

  root.addEventListener('pointermove', (e) => {
    if (drawing && e.pointerId === drawing.id) {
      moveMark(e);
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const [col, row] = cell(drag.idx);
    drag.el.classList.add('dragging');
    drag.el.style.transform = `translate(${col * 100}%, ${row * 100}%) translate(${dx}px, ${dy}px) scale(1.15)`;
  });

  function endDrag(e) {
    if (drawing && e.pointerId === drawing.id) {
      endMark(e);
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    // A press without movement is a click: the piece stays selected, or is
    // let go if it already was.
    if (!drag.moved) {
      const { again } = drag;
      drag = null;
      if (again) select(null);
      return;
    }
    const sq = e.type === 'pointerup' && document.elementFromPoint(e.clientX, e.clientY)?.closest('.sq');
    const idx = sq && root.contains(sq) ? Number(sq.dataset.idx) : null;
    if (idx !== null && targets.some((m) => m.to === idx)) choose(idx, true);
    else dropDrag(true);
  }
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);

  // The right button is for drawing.
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    update(next) {
      // A piece that is selected or in the player's hand stays there when the
      // position changes under it, as long as it is still theirs to move.
      const held = selected !== null && view ? seen.board[selected] : null;
      // Arrows go with the position they were drawn on.
      if (view && next.state.board.some((p, i) => !samePiece(p, view.state.board[i]))) marks = [];
      const variant = view?.state.variant;
      view = next;
      buildSquares();

      // On the player's turn the first premove is played, if it can be, and
      // the others wait for the next. One that cannot ends the queue.
      if (view.mode === 'move' && premoves.length) {
        const [{ from, to }, ...rest] = premoves;
        // A premoved pawn promotes to the first type on offer, the queen.
        const move = legalMoves(view.state, from).find((m) => m.to === to);
        premoves = move ? rest : [];
        if (move) {
          dropDrag(false);
          selected = null;
          targets = [];
          setDrop(null);
          playLocal({ from, to, promotion: move.promotion }, true);
          return;
        }
      }

      refresh();
      const now = selected !== null ? seen.board[selected] : null;
      const keep = Boolean(held && now && next.mode !== 'none' &&
        now.type === held.type && now.seat === held.seat && variant === next.state.variant);
      syncPieces(next.animate);
      if (!keep) {
        dropDrag(false);
        selected = null;
      }
      targets = selected === null ? [] : movesFrom(selected);
      // A pocket piece stays in hand only while it can still be dropped.
      if (dropType !== null && view.mode === 'move') targets = legalDrops(view.state, dropType);
      if (dropType !== null && !targets.length) setDrop(null);
      paint();
    },
    // Takes a piece from the pocket in hand: the next square clicked is where
    // it goes. With the pointer event that picked it up, it can be dragged.
    startDrop(type, e) {
      if (!view || view.mode !== 'move') return;
      dropDrag(false);
      selected = null;
      setDrop(type);
      targets = legalDrops(view.state, type);
      paint();
      if (!e || !targets.length) return;
      const el = div('chessGhost');
      el.style.backgroundImage = pieceImage(type, view.seat);
      ghost = { id: e.pointerId, el, x: e.clientX, y: e.clientY, moved: false };
      window.addEventListener('pointermove', moveGhost);
      window.addEventListener('pointerup', endGhost);
      window.addEventListener('pointercancel', endGhost);
    },
    cancelPremove() {
      if (!premoves.length || !view) {
        premoves = [];
        return;
      }
      clearPremoves();
      paint();
    },
  };
}

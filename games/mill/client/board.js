// Draws a Mill board as an SVG and turns clicks into moves: a point to put a
// piece down, or a piece and then where it goes; and when that closes a mill,
// one of the opponent's pieces to take. The wood, the stones and the
// coordinates follow the theme Go and Gomoku share (public/js/kit).
//
// One unit of the SVG is one step of the board's grid. Seat 0 plays White.

import { targets, closesMill, removable, EMPTY, LETTERS } from '../shared/rules.js';
import { showCoordinates, THEME_EVENT } from '/js/kit/stonetheme.js';
import { loadStylesheet } from '/js/kit/dom.js';

loadStylesheet(new URL('./mill.css', import.meta.url));

const SVG = 'http://www.w3.org/2000/svg';
const FADE_MS = 200;
const PIECE_R = 0.36;
const MARGIN_COORDS = 1.1;
const MARGIN_PLAIN = 0.6;
const COORD_OFFSET = 0.75;
// The stone colour of each seat's pieces, as the kit's classes name them.
const STONE = ['w', 'b'];

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

const viewBoxOf = (size, margin) => `${1 - margin} ${1 - margin} ${size - 1 + 2 * margin} ${size - 1 + 2 * margin}`;

// Where a point is drawn: x from the left, y from the top.
const placeOf = (v, p) => [v.points[p].x + 1, v.size - v.points[p].y];

// The board's lines and points, and the coordinates on all four sides when
// `coords` is set.
function drawGrid(v, coords) {
  const nodes = [svgEl('rect', { class: 'kitWood', width: v.size + 1, height: v.size + 1 })];
  const path = v.lines.map((line) => {
    const [x1, y1] = placeOf(v, line[0]);
    const [x2, y2] = placeOf(v, line[line.length - 1]);
    return `M${x1} ${y1}L${x2} ${y2}`;
  }).join('');
  nodes.push(svgEl('path', { class: 'kitLines millLines', d: path }));
  v.points.forEach((_, p) => {
    const [cx, cy] = placeOf(v, p);
    nodes.push(svgEl('circle', { class: 'kitStar millPoint', cx, cy, r: 0.12 }));
  });
  if (coords) {
    const near = 1 - COORD_OFFSET;
    const far = v.size + COORD_OFFSET;
    const label = (x, y, text) => {
      const node = svgEl('text', { class: 'kitCoord', x, y });
      node.textContent = text;
      return node;
    };
    for (let i = 0; i < v.size; i++) {
      nodes.push(label(i + 1, near, LETTERS[i]), label(i + 1, far, LETTERS[i]),
        label(near, v.size - i, String(i + 1)), label(far, v.size - i, String(i + 1)));
    }
  }
  return nodes;
}

// A small board that only shows a position, for lists of games. `board` has
// a character per point: 'w' first seat, 'b' second, '.' empty.
export function drawThumbnail(root, { variant: v, board, lastMove }) {
  root.classList.add('kitThumb');
  const svg = svgEl('svg', { viewBox: viewBoxOf(v.size, MARGIN_PLAIN) });
  svg.append(...drawGrid(v, false));
  [...board].forEach((c, p) => {
    if (c === '.') return;
    const [cx, cy] = placeOf(v, p);
    svg.append(svgEl('circle', { class: `kitStone ${c}`, cx, cy, r: PIECE_R }));
    if (lastMove && p === lastMove.to) svg.append(svgEl('circle', { class: `kitLast ${c}`, cx, cy, r: 0.17 }));
  });
  root.replaceChildren(svg);
}

// `onMove(move)` is called with { from, to, remove } once the player has
// made a whole move. `onTaking(taking)` says when the player has closed a
// mill and is choosing which piece to take.
export function createMillBoard(root, { onMove, onTaking = () => {} }) {
  const svg = svgEl('svg', { class: 'kitSvg' });
  const grid = svgEl('g');
  const hints = svgEl('g', { class: 'millHints' });
  const pieces = svgEl('g', { class: 'kitStones millPieces' });
  const marks = svgEl('g');
  svg.append(grid, hints, pieces, marks);
  root.replaceChildren(svg);
  root.classList.add('kitBoard', 'millBoard');

  // What is shown: { state, variant, lastMove, mode, animate }, where mode
  // is 'play' on the player's turn and 'none' otherwise.
  let view = null;
  let drawn = ''; // the variant and coordinates the grid was drawn for
  const shown = new Map(); // point -> { el, seat }
  let selected = null; // the piece about to move
  let taking = null; // the move waiting for a piece to take

  function build() {
    const key = `${view.variant.id}:${showCoordinates()}`;
    if (key === drawn) return;
    const sameBoard = drawn.startsWith(`${view.variant.id}:`);
    drawn = key;
    const coords = showCoordinates();
    svg.setAttribute('viewBox', viewBoxOf(view.variant.size, coords ? MARGIN_COORDS : MARGIN_PLAIN));
    grid.replaceChildren(...drawGrid(view.variant, coords));
    if (!sameBoard) {
      pieces.replaceChildren();
      shown.clear();
    }
  }
  const onTheme = () => {
    if (view) build();
  };
  document.addEventListener(THEME_EVENT, onTheme);

  function position(el, p) {
    const [x, y] = placeOf(view.variant, p);
    el.style.transform = `translate(${x}px, ${y}px)`;
  }

  // The pieces shown: the position, or while a mill is being closed the
  // position with the move made but nothing taken yet.
  function boardShown() {
    if (!taking) return view.state.board;
    const board = view.state.board.slice();
    if (taking.from !== undefined) board[taking.from] = EMPTY;
    board[taking.to] = view.state.turn;
    return board;
  }

  // Makes the piece elements match the board. A piece that moved slides
  // there; pieces taken fade out and pieces put down fade in.
  function syncPieces(animate, move) {
    const board = boardShown();
    const gone = new Map();
    for (const [p, entry] of shown) {
      if (board[p] === entry.seat) continue;
      shown.delete(p);
      gone.set(p, entry);
    }
    board.forEach((seat, p) => {
      if (seat === EMPTY || shown.has(p)) return;
      // The piece that moved here, if it was shown where it came from.
      const from = move && move.to === p && gone.get(move.from)?.seat === seat ? move.from : null;
      let entry;
      let className;
      if (from !== null) {
        entry = gone.get(from);
        gone.delete(from);
        className = animate ? '' : ' still';
      } else {
        entry = { el: svgEl('circle', { r: PIECE_R }), seat };
        pieces.append(entry.el);
        // Put straight where it belongs, not slid there from the corner.
        className = animate ? ' still millFresh' : ' still';
      }
      entry.el.setAttribute('class', `kitStone ${STONE[seat]}${className}`);
      position(entry.el, p);
      shown.set(p, entry);
    });
    for (const { el } of gone.values()) {
      if (animate) {
        el.classList.add('gone');
        setTimeout(() => el.remove(), FADE_MS);
      } else el.remove();
    }
  }

  // The last move's marks, and what the player may click.
  function paint() {
    const v = view.variant;
    const ring = (p, className, r) => {
      const [cx, cy] = placeOf(v, p);
      return svgEl('circle', { class: className, cx, cy, r });
    };
    const markNodes = [];
    const { lastMove } = view;
    if (lastMove && !taking) {
      const board = view.state.board;
      if (board[lastMove.to] !== EMPTY) markNodes.push(ring(lastMove.to, `kitLast ${STONE[board[lastMove.to]]}`, 0.17));
      if (lastMove.from !== undefined) markNodes.push(ring(lastMove.from, 'millFrom', 0.16));
      if (lastMove.remove !== undefined) markNodes.push(ring(lastMove.remove, 'millTaken', 0.22));
    }
    const hintNodes = [];
    if (view.mode === 'play') {
      if (taking) {
        for (const p of takeable()) hintNodes.push(ring(p, 'millTake', PIECE_R + 0.08));
      } else if (selected !== null) {
        hintNodes.push(ring(selected, 'millSelected', PIECE_R + 0.08));
        for (const p of targets(view.state, v, selected)) hintNodes.push(ring(p, 'millTarget', 0.16));
      }
    }
    marks.replaceChildren(...markNodes);
    hints.replaceChildren(...hintNodes);
    root.classList.toggle('playing', view.mode === 'play');
  }

  function takeable() {
    return removable(boardShown(), view.variant, 1 - view.state.turn);
  }

  // The point under the pointer, or null if none is near.
  function pointAt(e) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const at = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    let best = null;
    let nearest = 0.5;
    view.variant.points.forEach((_, p) => {
      const [x, y] = placeOf(view.variant, p);
      const d = Math.hypot(x - at.x, y - at.y);
      if (d < nearest) {
        nearest = d;
        best = p;
      }
    });
    return best;
  }

  function setTaking(move) {
    taking = move;
    onTaking(Boolean(move));
  }

  // A whole move: shown at once, sent to the server, and the board waits
  // for the next snapshot.
  function send(move) {
    const lastMove = move;
    selected = null;
    setTaking(null);
    const board = view.state.board.slice();
    if (move.from !== undefined) board[move.from] = EMPTY;
    board[move.to] = view.state.turn;
    if (move.remove !== undefined) board[move.remove] = EMPTY;
    view = { ...view, state: { ...view.state, board }, lastMove, mode: 'none' };
    syncPieces(true, move);
    paint();
    onMove(move);
  }

  // A step made; if it closes a mill the player picks what to take first.
  function step(move) {
    selected = null;
    if (closesMill(view.state, view.variant, move)) {
      setTaking(move);
      syncPieces(true, move);
      paint();
    } else send(move);
  }

  svg.addEventListener('pointerup', (e) => {
    if (!view || view.mode !== 'play' || e.button !== 0) return;
    const p = pointAt(e);
    const { state, variant: v } = view;
    if (taking) {
      if (p !== null && takeable().includes(p)) send({ ...taking, remove: p });
      else {
        // Anywhere else takes the step back.
        const move = taking;
        setTaking(null);
        syncPieces(true, { from: move.to, to: move.from ?? -1 });
        paint();
      }
      return;
    }
    if (p === null) {
      selected = null;
      paint();
      return;
    }
    if (state.inHand[state.turn]) {
      if (state.board[p] === EMPTY) step({ to: p });
      return;
    }
    if (state.board[p] === state.turn) {
      selected = selected === p || !targets(state, v, p).length ? null : p;
    } else if (selected !== null && targets(state, v, selected).includes(p)) {
      step({ from: selected, to: p });
      return;
    } else selected = null;
    paint();
  });

  return {
    update(next) {
      const animate = next.animate;
      // A choice under way stays only while the position is the same.
      if (!view || next.state !== view.state || next.mode !== 'play') {
        selected = null;
        if (taking) setTaking(null);
      }
      view = next;
      build();
      syncPieces(animate, next.lastMove);
      paint();
    },
    destroy() {
      document.removeEventListener(THEME_EVENT, onTheme);
    },
  };
}

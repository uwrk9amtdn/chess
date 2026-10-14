// Draws a Go position as an SVG and turns clicks into moves. One unit of the
// SVG is the distance between two lines; the lines run from 1 to `size`, and
// the margin around them holds the coordinates, when they are shown.
//
// Stones keep their element from one position to the next, so only the
// stones that come and go change, and they can fade in and out.

import { isLegal, applyMove, starPoints, pointName, BLACK } from '../shared/rules.js';
import { showCoordinates, THEME_EVENT } from './theme.js';

const SVG = 'http://www.w3.org/2000/svg';
const FADE_MS = 200;
const STONE_R = 0.47;
// The wood beyond the outer lines: room for the coordinates on every side,
// or a narrow rim without them.
const MARGIN_COORDS = 0.85;
const MARGIN_PLAIN = 0.6;
// Where the coordinates sit, from the outer lines.
const COORD_OFFSET = 0.45;

const viewBoxOf = (size, margin) => `${1 - margin} ${1 - margin} ${size - 1 + 2 * margin} ${size - 1 + 2 * margin}`;

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

// Where a point is drawn: x from the left, y from the top.
const placeOf = (size, point) => [(point % size) + 1, size - Math.floor(point / size)];

// The lines and star points of an empty board, with the coordinates on all
// four sides when `coords` is set.
function drawGrid(size, coords) {
  const lines = [];
  for (let i = 1; i <= size; i++) lines.push(`M1 ${i}H${size}M${i} 1V${size}`);
  const nodes = [
    svgEl('rect', { class: 'goWood', width: size + 1, height: size + 1 }),
    svgEl('path', { class: 'goLines', d: lines.join('') }),
    svgEl('rect', { class: 'goBorder', x: 1, y: 1, width: size - 1, height: size - 1 }),
  ];
  for (const p of starPoints(size)) {
    const [cx, cy] = placeOf(size, p);
    nodes.push(svgEl('circle', { class: 'goStar', cx, cy, r: size < 13 ? 0.09 : 0.11 }));
  }
  if (coords) {
    const near = 1 - COORD_OFFSET;
    const far = size + COORD_OFFSET;
    const label = (x, y, text) => {
      const node = svgEl('text', { class: 'goCoord', x, y });
      node.textContent = text;
      return node;
    };
    for (let i = 0; i < size; i++) {
      const letter = pointName(size, i)[0];
      const number = String(i + 1);
      nodes.push(label(i + 1, near, letter), label(i + 1, far, letter), label(near, size - i, number), label(far, size - i, number));
    }
  }
  return nodes;
}

// A small board that only shows a position, for lists of games. `board` has
// a character per point: 'x' Black, 'o' White, '.' empty.
export function drawThumbnail(root, { size, board, lastMove }) {
  root.classList.add('goThumb');
  const svg = svgEl('svg', { viewBox: viewBoxOf(size, MARGIN_PLAIN) });
  svg.append(...drawGrid(size, false));
  [...board].forEach((c, p) => {
    if (c === '.') return;
    const [cx, cy] = placeOf(size, p);
    svg.append(svgEl('circle', { class: `goStone ${c === 'x' ? 'b' : 'w'}`, cx, cy, r: STONE_R }));
    if (p === lastMove) svg.append(svgEl('circle', { class: `goLast ${c === 'x' ? 'b' : 'w'}`, cx, cy, r: 0.2 }));
  });
  root.replaceChildren(svg);
}

// `onPlay(point)` is called when the player puts down a stone, and
// `onToggle(point)` when they mark a chain dead or alive while counting.
export function createBoard(root, { onPlay, onToggle }) {
  const svg = svgEl('svg', { class: 'goSvg' });
  const grid = svgEl('g');
  const territory = svgEl('g', { class: 'goTerritory' });
  const stones = svgEl('g', { class: 'goStones' });
  const marks = svgEl('g');
  const last = svgEl('circle', { class: 'goLast', r: 0.2 });
  const ghost = svgEl('circle', { class: 'goStone goGhost', r: STONE_R });
  marks.append(last, ghost);
  svg.append(grid, territory, stones, marks);
  root.replaceChildren(svg);

  // { state, seat, lastMove, mode, owner, dead, animate }. `mode` is 'play'
  // on the player's turn, 'mark' while dead stones are being agreed on and
  // 'none' when the board is only for looking at. `owner` (or null) gives
  // whose area each point is in, and `dead` the stones marked dead.
  let view = null;
  let size = 0;
  let coords = null; // whether the coordinates were drawn
  const shown = new Map(); // point -> { el, colour }
  let hover = null; // the point under the mouse
  // On a touch screen the first tap only shows where the stone would go,
  // and a second one on the same point plays it.
  let pending = null;

  function build() {
    if (view.state.size !== size) {
      size = view.state.size;
      root.style.setProperty('--go-size', size);
      stones.replaceChildren();
      shown.clear();
      coords = null;
    }
    if (coords === showCoordinates()) return;
    coords = showCoordinates();
    svg.setAttribute('viewBox', viewBoxOf(size, coords ? MARGIN_COORDS : MARGIN_PLAIN));
    grid.replaceChildren(...drawGrid(size, coords));
  }
  // Switching the coordinates in the theme menu redraws the grid at once.
  const onTheme = () => {
    if (view) build();
  };
  document.addEventListener(THEME_EVENT, onTheme);

  function syncStones(animate) {
    const { board } = view.state;
    const dead = view.dead ?? new Set();
    for (const [p, entry] of shown) {
      if (board[p] === entry.colour) continue;
      shown.delete(p);
      if (animate) {
        entry.el.classList.add('gone');
        setTimeout(() => entry.el.remove(), FADE_MS);
      } else entry.el.remove();
    }
    board.forEach((colour, p) => {
      if (colour < 0) return;
      let entry = shown.get(p);
      if (!entry) {
        const [cx, cy] = placeOf(size, p);
        entry = { el: svgEl('circle', { cx, cy, r: STONE_R }), colour };
        entry.el.dataset.point = p;
        if (animate) entry.el.classList.add('fresh');
        stones.append(entry.el);
        shown.set(p, entry);
      }
      entry.el.setAttribute('class', `goStone ${colour === BLACK ? 'b' : 'w'}${dead.has(p) ? ' dead' : ''}`);
    });
  }

  function paintTerritory() {
    const { owner } = view;
    const squares = [];
    owner?.forEach((who, p) => {
      // Points with a living stone are that stone's; only the rest is marked.
      if (who < 0 || (view.state.board[p] >= 0 && !view.dead?.has(p))) return;
      const [cx, cy] = placeOf(size, p);
      squares.push(svgEl('rect', {
        class: who === BLACK ? 'b' : 'w', x: cx - 0.17, y: cy - 0.17, width: 0.34, height: 0.34,
      }));
    });
    territory.replaceChildren(...squares);
  }

  function paintMarks() {
    const { state, lastMove, mode, seat } = view;
    last.style.display = lastMove === null || lastMove === undefined || state.board[lastMove] < 0 ? 'none' : '';
    if (last.style.display === '') {
      const [cx, cy] = placeOf(size, lastMove);
      last.setAttribute('cx', cx);
      last.setAttribute('cy', cy);
      last.setAttribute('class', `goLast ${state.board[lastMove] === BLACK ? 'b' : 'w'}`);
    }
    const at = pending ?? hover;
    const showGhost = mode === 'play' && at !== null && isLegal(state, { point: at });
    ghost.style.display = showGhost ? '' : 'none';
    if (showGhost) {
      const [cx, cy] = placeOf(size, at);
      ghost.setAttribute('cx', cx);
      ghost.setAttribute('cy', cy);
      ghost.setAttribute('class', `goStone goGhost ${seat === BLACK ? 'b' : 'w'}${pending !== null ? ' pending' : ''}`);
    }
    root.classList.toggle('playing', mode === 'play');
    root.classList.toggle('marking', mode === 'mark');
  }

  // The point nearest to where the pointer is, or null off the grid.
  function pointAt(e) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const at = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
    const x = Math.round(at.x) - 1;
    const y = size - Math.round(at.y);
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    return y * size + x;
  }

  // Shows the stone straight away; the server's next snapshot replaces it.
  function play(point) {
    pending = hover = null;
    view = { ...view, state: applyMove(view.state, { point }), lastMove: point, mode: 'none' };
    syncStones(true);
    paintMarks();
    onPlay(point);
  }

  svg.addEventListener('pointermove', (e) => {
    if (!view || e.pointerType !== 'mouse') return;
    const point = pointAt(e);
    if (point === hover) return;
    hover = point;
    paintMarks();
  });
  svg.addEventListener('pointerleave', () => {
    hover = null;
    if (view) paintMarks();
  });
  svg.addEventListener('pointerup', (e) => {
    if (!view || e.button !== 0) return;
    const point = pointAt(e);
    if (point === null) return;
    if (view.mode === 'mark') {
      if (view.state.board[point] >= 0) onToggle(point);
      return;
    }
    if (view.mode !== 'play' || !isLegal(view.state, { point })) {
      pending = null;
      paintMarks();
      return;
    }
    if (e.pointerType === 'mouse' || pending === point) play(point);
    else {
      pending = point;
      paintMarks();
    }
  });

  return {
    update(next) {
      // A tentative stone stays only while it is still the player's turn.
      if (next.mode !== 'play' || (view && next.state !== view.state)) pending = null;
      view = next;
      build();
      syncStones(next.animate);
      paintTerritory();
      paintMarks();
    },
    destroy() {
      document.removeEventListener(THEME_EVENT, onTheme);
    },
  };
}

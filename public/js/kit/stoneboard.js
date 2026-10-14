// A board of lines with stones on the points, for Go and Gomoku: draws a
// position as an SVG and turns clicks into moves. It knows nothing of either
// game's rules; the game says which points may be played and what the board
// looks like after a stone is put down.
//
// One unit of the SVG is the distance between two lines; the lines run from
// 1 to `size`, and the margin around them holds the coordinates, when they
// are shown. Points are numbered y * size + x from the bottom left. A stone
// is 0 (Black) or 1 (White); -1 is an empty point.
//
// Stones keep their element from one position to the next, so only the
// stones that come and go change, and they can fade in and out.

import { showCoordinates, THEME_EVENT } from './stonetheme.js';

const SVG = 'http://www.w3.org/2000/svg';
const FADE_MS = 200;
const STONE_R = 0.47;
// The wood beyond the outer lines: room for the coordinates on every side,
// or a narrow rim without them.
const MARGIN_COORDS = 1.05;
const MARGIN_PLAIN = 0.6;
// Where the coordinates sit, from the outer lines.
const COORD_OFFSET = 0.7;

const COLOUR_CLASS = ['b', 'w'];

const viewBoxOf = (size, margin) => `${1 - margin} ${1 - margin} ${size - 1 + 2 * margin} ${size - 1 + 2 * margin}`;

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

// Where a point is drawn: x from the left, y from the top.
const placeOf = (size, point) => [(point % size) + 1, size - Math.floor(point / size)];

// The lines and star points of an empty board, with the coordinates on all
// four sides when `letters` (one per column) is given.
function drawGrid(size, stars, letters) {
  const lines = [];
  for (let i = 1; i <= size; i++) lines.push(`M1 ${i}H${size}M${i} 1V${size}`);
  const nodes = [
    svgEl('rect', { class: 'kitWood', width: size + 1, height: size + 1 }),
    svgEl('path', { class: 'kitLines', d: lines.join('') }),
    svgEl('rect', { class: 'kitBorder', x: 1, y: 1, width: size - 1, height: size - 1 }),
  ];
  for (const p of stars) {
    const [cx, cy] = placeOf(size, p);
    nodes.push(svgEl('circle', { class: 'kitStar', cx, cy, r: size < 13 ? 0.09 : 0.11 }));
  }
  if (letters) {
    const near = 1 - COORD_OFFSET;
    const far = size + COORD_OFFSET;
    const label = (x, y, text) => {
      const node = svgEl('text', { class: 'kitCoord', x, y });
      node.textContent = text;
      return node;
    };
    for (let i = 0; i < size; i++) {
      const number = String(i + 1);
      nodes.push(label(i + 1, near, letters[i]), label(i + 1, far, letters[i]),
        label(near, size - i, number), label(far, size - i, number));
    }
  }
  return nodes;
}

// A line through the five (or more) stones that won.
function winLine(size, points) {
  const ends = points.map((p) => placeOf(size, p)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const [[x1, y1], [x2, y2]] = [ends[0], ends[ends.length - 1]];
  return svgEl('line', { class: 'kitWinLine', x1, y1, x2, y2 });
}

// A small board that only shows a position, for lists of games. `board` has
// a character per point: 'x' Black, 'o' White, '.' empty. `line` is a row
// of stones to strike through, if any.
export function drawThumbnail(root, { size, board, lastMove, stars = [], line = null }) {
  root.classList.add('kitThumb');
  const svg = svgEl('svg', { viewBox: viewBoxOf(size, MARGIN_PLAIN) });
  svg.append(...drawGrid(size, stars, null));
  [...board].forEach((c, p) => {
    if (c === '.') return;
    const [cx, cy] = placeOf(size, p);
    const colour = c === 'x' ? 'b' : 'w';
    svg.append(svgEl('circle', { class: `kitStone ${colour}`, cx, cy, r: STONE_R }));
    if (p === lastMove) svg.append(svgEl('circle', { class: `kitLast ${colour}`, cx, cy, r: 0.2 }));
  });
  if (line) svg.append(winLine(size, line));
  root.replaceChildren(svg);
}

// `onPlay(point)` is called when the player puts down a stone, and
// `onToggle(point)` when they click a stone while marking (Go's dead stones).
// `letters` names the columns; `stars(size)` gives the marked points.
export function createStoneBoard(root, { onPlay, onToggle = () => {}, letters, stars = () => [] }) {
  const svg = svgEl('svg', { class: 'kitSvg' });
  const grid = svgEl('g');
  const territory = svgEl('g', { class: 'kitTerritory' });
  const stones = svgEl('g', { class: 'kitStones' });
  const marks = svgEl('g');
  const forbidden = svgEl('g', { class: 'kitForbidden' });
  const lineLayer = svgEl('g');
  const last = svgEl('circle', { class: 'kitLast', r: 0.2 });
  const ghost = svgEl('circle', { class: 'kitStone kitGhost', r: STONE_R });
  marks.append(last, ghost);
  svg.append(grid, territory, forbidden, stones, lineLayer, marks);
  root.replaceChildren(svg);
  root.classList.add('kitBoard');

  // What is shown:
  //   size, stones   the position
  //   lastMove       the point to mark as just played, or null
  //   mode           'play' when the player may put down a stone, 'mark'
  //                  when they may click stones, 'none' to only look
  //   colour         the colour the player would put down
  //   isLegal(p)     whether a stone may go on point p (default: if empty)
  //   afterPlay(p)   the stones once one is put on p (default: just that one)
  //   owner, dead    whose area each point is in, and stones marked dead
  //   forbidden      points marked as not to be played
  //   line           stones to strike through, such as a winning five
  //   animate        whether stones that come and go fade
  let view = null;
  let size = 0;
  let coords = null; // whether the coordinates were drawn
  const shown = new Map(); // point -> { el, colour }
  let hover = null; // the point under the mouse
  // On a touch screen the first tap only shows where the stone would go,
  // and a second one on the same point plays it.
  let pending = null;

  const legal = (p) => (view.isLegal ? view.isLegal(p) : view.stones[p] < 0);

  function build() {
    if (view.size !== size) {
      size = view.size;
      stones.replaceChildren();
      shown.clear();
      coords = null;
    }
    if (coords === showCoordinates()) return;
    coords = showCoordinates();
    svg.setAttribute('viewBox', viewBoxOf(size, coords ? MARGIN_COORDS : MARGIN_PLAIN));
    grid.replaceChildren(...drawGrid(size, stars(size), coords ? letters : null));
  }
  // Switching the coordinates in the theme menu redraws the grid at once.
  const onTheme = () => {
    if (view) build();
  };
  document.addEventListener(THEME_EVENT, onTheme);

  function syncStones(animate) {
    const dead = view.dead ?? new Set();
    for (const [p, entry] of shown) {
      if (view.stones[p] === entry.colour) continue;
      shown.delete(p);
      if (animate) {
        entry.el.classList.add('gone');
        setTimeout(() => entry.el.remove(), FADE_MS);
      } else entry.el.remove();
    }
    view.stones.forEach((colour, p) => {
      if (colour < 0) return;
      let entry = shown.get(p);
      if (!entry) {
        const [cx, cy] = placeOf(size, p);
        entry = { el: svgEl('circle', { cx, cy, r: STONE_R }), colour };
        if (animate) entry.el.classList.add('fresh');
        stones.append(entry.el);
        shown.set(p, entry);
      }
      entry.el.setAttribute('class', `kitStone ${COLOUR_CLASS[colour]}${dead.has(p) ? ' dead' : ''}`);
    });
  }

  function paintAreas() {
    const squares = [];
    view.owner?.forEach((who, p) => {
      // Points with a living stone are that stone's; only the rest is marked.
      if (who < 0 || (view.stones[p] >= 0 && !view.dead?.has(p))) return;
      const [cx, cy] = placeOf(size, p);
      squares.push(svgEl('rect', { class: COLOUR_CLASS[who], x: cx - 0.17, y: cy - 0.17, width: 0.34, height: 0.34 }));
    });
    territory.replaceChildren(...squares);
    forbidden.replaceChildren(...(view.forbidden ?? []).map((p) => {
      const [cx, cy] = placeOf(size, p);
      return svgEl('path', { d: `M${cx - 0.15} ${cy - 0.15}l0.3 0.3m0 -0.3l-0.3 0.3` });
    }));
    lineLayer.replaceChildren(...(view.line ? [winLine(size, view.line)] : []));
  }

  function paintMarks() {
    const { stones: board, lastMove, mode, colour } = view;
    const marked = lastMove !== null && lastMove !== undefined && board[lastMove] >= 0;
    last.style.display = marked ? '' : 'none';
    if (marked) {
      const [cx, cy] = placeOf(size, lastMove);
      last.setAttribute('cx', cx);
      last.setAttribute('cy', cy);
      last.setAttribute('class', `kitLast ${COLOUR_CLASS[board[lastMove]]}`);
    }
    const at = pending ?? hover;
    const showGhost = mode === 'play' && at !== null && legal(at);
    ghost.style.display = showGhost ? '' : 'none';
    if (showGhost) {
      const [cx, cy] = placeOf(size, at);
      ghost.setAttribute('cx', cx);
      ghost.setAttribute('cy', cy);
      ghost.setAttribute('class', `kitStone kitGhost ${COLOUR_CLASS[colour]}${pending !== null ? ' pending' : ''}`);
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
    let after = view.afterPlay?.(point);
    if (!after) {
      after = view.stones.slice();
      after[point] = view.colour;
    }
    view = { ...view, stones: after, lastMove: point, mode: 'none', forbidden: null };
    syncStones(true);
    paintAreas();
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
      if (view.stones[point] >= 0) onToggle(point);
      return;
    }
    if (view.mode !== 'play' || !legal(point)) {
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
      if (next.mode !== 'play' || (view && next.stones !== view.stones)) pending = null;
      view = next;
      build();
      syncStones(next.animate);
      paintAreas();
      paintMarks();
    },
    destroy() {
      document.removeEventListener(THEME_EVENT, onTheme);
    },
  };
}

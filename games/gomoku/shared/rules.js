// The rules of Gomoku: five in a row, in three variants. Used by the server
// to judge moves, by the browser to replay them and mark forbidden points,
// and by the bot.
//
// Points are numbered y * size + x, with x = 0 on the left and y = 0 on the
// bottom row (row "1"). Each point holds BLACK, WHITE or EMPTY. Black moves
// first, and the two colours always alternate, also while the Swap2 opening
// is being laid down; who plays which colour is the match's business.

export const EMPTY = -1;
export const BLACK = 0;
export const WHITE = 1;

export const VARIANTS = {
  freestyle: {
    id: 'freestyle',
    name: 'Freestyle',
    description: 'Five or more in a row wins.',
    sizes: [15, 19],
  },
  standard: {
    id: 'standard',
    name: 'Standard',
    description: 'Exactly five in a row wins; six or more does not.',
    sizes: [15],
  },
  renju: {
    id: 'renju',
    name: 'Renju',
    description: 'Black may not make a double three, a double four or more than five; exactly five wins for Black, five or more for White.',
    sizes: [15],
  },
};

export const LETTERS = 'ABCDEFGHIJKLMNOPQRS';

export const pointName = (size, point) => LETTERS[point % size] + (Math.floor(point / size) + 1);

// The marked points: the centre and four more on the fourth lines.
export function starPoints(size) {
  const at = (x, y) => y * size + x;
  const lo = 3;
  const hi = size - 4;
  const mid = (size - 1) / 2;
  const points = [at(lo, lo), at(hi, lo), at(lo, hi), at(hi, hi), at(mid, mid)];
  if (size >= 19) points.push(at(lo, mid), at(hi, mid), at(mid, lo), at(mid, hi));
  return points;
}

export function createGame(size) {
  return { size, board: new Array(size * size).fill(EMPTY), turn: BLACK, count: 0 };
}

const SYMBOLS = '.xo';
export const boardKey = (board) => board.map((c) => SYMBOLS[c + 1]).join('');

// The four directions a row can run in.
export const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]];

// The point `steps` away from `point` in direction (dx, dy), or -1 off the board.
function step(size, point, dx, dy, steps) {
  const x = (point % size) + dx * steps;
  const y = Math.floor(point / size) + dy * steps;
  return x < 0 || y < 0 || x >= size || y >= size ? -1 : y * size + x;
}

// The stones of `point`'s colour in an unbroken row through it, in order.
export function runThrough(board, size, point, dx, dy) {
  const colour = board[point];
  const run = [point];
  for (const sign of [-1, 1]) {
    for (let n = 1; ; n++) {
      const p = step(size, point, dx * sign, dy * sign, n);
      if (p < 0 || board[p] !== colour) break;
      if (sign < 0) run.unshift(p);
      else run.push(p);
    }
  }
  return run;
}

// Whether a row of `length` stones of `colour` wins in `variant`.
function wins(variant, colour, length) {
  if (variant === 'freestyle') return length >= 5;
  if (variant === 'renju' && colour === WHITE) return length >= 5;
  return length === 5;
}

// The winning row through the stone on `point`, or null.
export function fiveAt(board, size, point, variant) {
  for (const [dx, dy] of DIRECTIONS) {
    const run = runThrough(board, size, point, dx, dy);
    if (wins(variant, board[point], run.length)) return run;
  }
  return null;
}

// ---- Renju's forbidden moves ----

// The empty points on the line through `point` (a black stone) that would
// make exactly five with it, as their distance along the line.
function completions(board, size, point, dx, dy) {
  const found = [];
  for (let n = -4; n <= 4; n++) {
    const q = step(size, point, dx, dy, n);
    if (n === 0 || q < 0 || board[q] !== EMPTY) continue;
    board[q] = BLACK;
    if (runThrough(board, size, point, dx, dy).length === 5) found.push(n);
    board[q] = EMPTY;
  }
  return found;
}

// How many fours the black stone on `point` is part of along one line. Two
// ways to make five four points apart are one straight four (_XXXX_);
// otherwise each way is a four of its own, so that X_XXX_X... counts two.
function foursOnLine(board, size, point, dx, dy) {
  const found = completions(board, size, point, dx, dy);
  if (found.length === 2 && found[1] - found[0] === 5) return 1;
  return found.length;
}

const isStraightFour = (found) => found.length === 2 && found[1] - found[0] === 5;

// Whether the black stone on `point` makes a real three along one line: one
// more black stone, itself allowed, would make a straight four through it.
function threeOnLine(board, size, point, dx, dy, depth) {
  for (let n = -4; n <= 4; n++) {
    const q = step(size, point, dx, dy, n);
    if (n === 0 || q < 0 || board[q] !== EMPTY) continue;
    board[q] = BLACK;
    const straight = isStraightFour(completions(board, size, point, dx, dy));
    board[q] = EMPTY;
    if (straight && !forbiddenReason(board, size, q, depth + 1)) return true;
  }
  return false;
}

// Past this depth a point that would make a three is taken as allowed; the
// cases that need more are vanishingly rare.
const MAX_DEPTH = 3;

// Why Black may not play on the empty `point` in Renju ('overline', 'double
// four' or 'double three'), or null if it may. Exactly five always may.
export function forbiddenReason(board, size, point, depth = 0) {
  if (board[point] !== EMPTY) return null;
  board[point] = BLACK;
  try {
    let overline = false;
    for (const [dx, dy] of DIRECTIONS) {
      const length = runThrough(board, size, point, dx, dy).length;
      if (length === 5) return null;
      if (length > 5) overline = true;
    }
    if (overline) return 'overline';
    let fours = 0;
    let threes = 0;
    for (const [dx, dy] of DIRECTIONS) {
      const f = foursOnLine(board, size, point, dx, dy);
      fours += f;
      // A line with a four in it is not also a three.
      if (!f && depth < MAX_DEPTH && threeOnLine(board, size, point, dx, dy, depth)) threes++;
    }
    if (fours >= 2) return 'double four';
    if (threes >= 2) return 'double three';
    return null;
  } finally {
    board[point] = EMPTY;
  }
}

// The points Black may not play in this position.
export function forbiddenPoints(state, variant) {
  if (variant !== 'renju' || state.turn !== BLACK) return [];
  const board = state.board.slice();
  const points = [];
  for (let p = 0; p < board.length; p++) {
    if (board[p] === EMPTY && hasNeighbour(board, state.size, p) && forbiddenReason(board, state.size, p)) points.push(p);
  }
  return points;
}

// Whether any stone is within two points of `point`; a forbidden move needs
// stones near it.
function hasNeighbour(board, size, point) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const p = step(size, point, dx, dy, 1);
      if (p >= 0 && p !== point && board[p] !== EMPTY) return true;
    }
  }
  return false;
}

// ---- moves ----

// The position after a stone on `point`, with the winning row it made (or
// null), or { error }.
export function tryMove(state, point, variant) {
  const { size } = state;
  if (!Number.isInteger(point) || point < 0 || point >= size * size) return { error: 'Not a point on the board' };
  if (state.board[point] !== EMPTY) return { error: 'That point is taken' };
  if (variant === 'renju' && state.turn === BLACK) {
    const reason = forbiddenReason(state.board.slice(), size, point);
    if (reason) return { error: `Black may not play there: ${reason}` };
  }
  const board = state.board.slice();
  board[point] = state.turn;
  return {
    state: { size, board, turn: 1 - state.turn, count: state.count + 1 },
    line: fiveAt(board, size, point, variant),
  };
}

// For replaying moves the server has already accepted.
export function applyMove(state, point, variant) {
  const result = tryMove(state, point, variant);
  if (result.error) throw new Error(result.error);
  return result.state;
}

export const isFull = (state) => state.count === state.size * state.size;

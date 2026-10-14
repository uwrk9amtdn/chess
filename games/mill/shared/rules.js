// The rules of Mill (Nine, Six and Twelve Men's Morris). Used by the server
// to judge moves, by the browser to replay them and to show what may be
// played, and by the bot.
//
// A board is described by its lines: points one step apart along a line
// are neighbours, and a line of three points is a mill. Each point holds the
// seat whose piece is on it, or EMPTY. Seat 0 plays White and moves first.
//
// A turn puts a piece down from the hand (while any are left), or moves one
// along a line to a free neighbour, or, with only three left, to any free
// point. Closing a mill takes one of the opponent's pieces off the board:
// one not in a mill, unless every one of them is. A player left with two
// pieces, or with no move, has lost.

export const EMPTY = -1;
export const LETTERS = 'abcdefg';
// After this many moves in a row without a piece put down or taken (fifty
// by each player), the game is drawn.
export const QUIET_LIMIT = 100;

// The lines of a board of `squares` nested squares on a grid of `size`
// points a side, the squares joined at the middle of their sides and, with
// `diagonals`, at their corners.
function linesOf(size, squares, diagonals) {
  const mid = (size - 1) / 2;
  const lines = [];
  for (let k = 0; k < squares; k++) {
    const lo = k;
    const hi = size - 1 - k;
    lines.push([[lo, lo], [mid, lo], [hi, lo]], [[hi, lo], [hi, mid], [hi, hi]],
      [[hi, hi], [mid, hi], [lo, hi]], [[lo, hi], [lo, mid], [lo, lo]]);
  }
  const across = (from, step) => Array.from({ length: squares }, (_, k) => [from[0] + step[0] * k, from[1] + step[1] * k]);
  lines.push(across([mid, 0], [0, 1]), across([size - 1, mid], [-1, 0]), across([mid, size - 1], [0, -1]), across([0, mid], [1, 0]));
  if (diagonals) {
    lines.push(across([0, 0], [1, 1]), across([size - 1, 0], [-1, 1]),
      across([size - 1, size - 1], [-1, -1]), across([0, size - 1], [1, -1]));
  }
  return lines;
}

// A variant from its board: the points with their place on the grid and
// name, each point's neighbours, and the mills.
function variant(id, { name, short, description, pieces, size, squares, diagonals = false }) {
  const lines = linesOf(size, squares, diagonals);
  const points = [];
  const index = new Map();
  for (const line of lines) {
    for (const [x, y] of line) {
      const key = `${x},${y}`;
      if (index.has(key)) continue;
      index.set(key, points.length);
      points.push({ x, y, name: LETTERS[x] + (y + 1) });
    }
  }
  const asPoints = lines.map((line) => line.map(([x, y]) => index.get(`${x},${y}`)));
  const neighbours = points.map(() => []);
  for (const line of asPoints) {
    for (let i = 1; i < line.length; i++) {
      neighbours[line[i - 1]].push(line[i]);
      neighbours[line[i]].push(line[i - 1]);
    }
  }
  const mills = asPoints.filter((line) => line.length === 3);
  const millsAt = points.map((_, p) => mills.filter((m) => m.includes(p)));
  return { id, name, short, description, pieces, size, points, lines: asPoints, neighbours, mills, millsAt };
}

export const VARIANTS = {
  nine: variant('nine', {
    name: "Nine Men's Morris",
    short: 'Nine',
    description: 'Nine pieces each on three squares: the classic game.',
    pieces: 9,
    size: 7,
    squares: 3,
  }),
  six: variant('six', {
    name: "Six Men's Morris",
    short: 'Six',
    description: 'Six pieces each on two squares: shorter and sharper.',
    pieces: 6,
    size: 5,
    squares: 2,
  }),
  twelve: variant('twelve', {
    name: "Twelve Men's Morris",
    short: 'Twelve',
    description: 'Twelve pieces each, with diagonals; a board filled by the pieces is a draw.',
    pieces: 12,
    size: 7,
    squares: 3,
    diagonals: true,
  }),
};

export function createGame(v) {
  const state = {
    board: new Array(v.points.length).fill(EMPTY),
    turn: 0,
    inHand: [v.pieces, v.pieces],
    onBoard: [0, 0],
    // Moves since a piece was last put down or taken.
    quiet: 0,
    // The positions since then, for repetition.
    seen: [],
  };
  state.seen = [positionKey(state)];
  return state;
}

export const positionKey = (state) => `${state.turn}:${state.board.map((c) => c + 1).join('')}`;

const flying = (state, seat) => !state.inHand[seat] && state.onBoard[seat] === 3;

// Whether the piece on `point` (or a piece of `seat` put there) is in a mill.
export function inMill(board, v, point, seat = board[point]) {
  return v.millsAt[point].some((mill) => mill.every((p) => p === point || board[p] === seat));
}

// The opponent's pieces that may be taken: those not in a mill, or any if
// all are.
export function removable(board, v, seat) {
  const pieces = [];
  board.forEach((c, p) => {
    if (c === seat) pieces.push(p);
  });
  const free = pieces.filter((p) => !inMill(board, v, p));
  return free.length ? free : pieces;
}

// Where the piece on `from` may go: any free point when flying, else a free
// neighbour.
export function targets(state, v, from) {
  const seat = state.board[from];
  if (flying(state, seat)) return state.board.flatMap((c, p) => (c === EMPTY ? [p] : []));
  return v.neighbours[from].filter((p) => state.board[p] === EMPTY);
}

// The board once `seat` has put a piece on `to` (from `from`, if moving).
function boardAfter(board, from, to, seat) {
  const next = board.slice();
  if (from !== undefined) next[from] = EMPTY;
  next[to] = seat;
  return next;
}

// Whether moving (or putting) a piece to `to` closes a mill, so that a
// piece must be taken.
export function closesMill(state, v, move) {
  const board = boardAfter(state.board, move.from, move.to, state.turn);
  return inMill(board, v, move.to) && removable(board, v, 1 - state.turn).length > 0;
}

// Every legal move for the side to move, a separate one for each piece it
// could take.
export function legalMoves(state, v) {
  const seat = state.turn;
  const steps = [];
  if (state.inHand[seat]) {
    state.board.forEach((c, p) => {
      if (c === EMPTY) steps.push({ to: p });
    });
  } else {
    state.board.forEach((c, p) => {
      if (c === seat) for (const to of targets(state, v, p)) steps.push({ from: p, to });
    });
  }
  const moves = [];
  for (const step of steps) {
    if (!closesMill(state, v, step)) {
      moves.push(step);
      continue;
    }
    const board = boardAfter(state.board, step.from, step.to, seat);
    for (const remove of removable(board, v, 1 - seat)) moves.push({ ...step, remove });
  }
  return moves;
}

// The position after `move`, which must be legal.
export function play(state, v, move) {
  const seat = state.turn;
  const board = boardAfter(state.board, move.from, move.to, seat);
  const inHand = state.inHand.slice();
  const onBoard = state.onBoard.slice();
  if (move.from === undefined) {
    inHand[seat]--;
    onBoard[seat]++;
  }
  if (move.remove !== undefined) {
    board[move.remove] = EMPTY;
    onBoard[1 - seat]--;
  }
  const progress = move.from === undefined || move.remove !== undefined;
  const next = { board, turn: 1 - seat, inHand, onBoard, quiet: progress ? 0 : state.quiet + 1, seen: [] };
  const key = positionKey(next);
  // Nothing before a piece was put down or taken can come back.
  next.seen = progress ? [key] : [...state.seen, key];
  return next;
}

// The position after `move`, or { error } if it is not allowed.
export function tryMove(state, v, move) {
  const { from, to, remove } = move;
  const n = v.points.length;
  const onBoard = (p) => Number.isInteger(p) && p >= 0 && p < n;
  if (!onBoard(to) || state.board[to] !== EMPTY) return { error: 'Choose a free point' };
  if (state.inHand[state.turn]) {
    if (from !== undefined) return { error: 'Put down all your pieces first' };
  } else {
    if (!onBoard(from) || state.board[from] !== state.turn) return { error: 'Move one of your own pieces' };
    if (!targets(state, v, from).includes(to)) return { error: 'Pieces move along a line to the next point' };
  }
  if (closesMill(state, v, move)) {
    const board = boardAfter(state.board, from, to, state.turn);
    if (!removable(board, v, 1 - state.turn).includes(remove)) {
      return { error: 'Take one of the opponent\'s pieces, one not in a mill if there is one' };
    }
  } else if (remove !== undefined) return { error: 'Only a mill takes a piece' };
  return { state: play(state, v, { from, to, remove }) };
}

// For replaying moves the server has already accepted.
export function applyMove(state, v, move) {
  const result = tryMove(state, v, move);
  if (result.error) throw new Error(result.error);
  return result.state;
}

// Whether the side to move can move at all.
function canMove(state, v) {
  const seat = state.turn;
  if (state.inHand[seat]) return state.board.includes(EMPTY);
  return state.board.some((c, p) => c === seat && targets(state, v, p).length > 0);
}

// Whether the game has ended with this position: { over: false } or
// { over: true, reason, winner } with winner a seat, or null for a draw.
export function status(state, v) {
  const seat = state.turn;
  const pieces = (s) => state.inHand[s] + state.onBoard[s];
  if (pieces(seat) < 3) return { over: true, reason: 'pieces', winner: 1 - seat };
  // Twelve pieces each fill the board of 24 points.
  if (!state.inHand[0] && !state.inHand[1] && !state.board.includes(EMPTY)) return { over: true, reason: 'full', winner: null };
  if (!canMove(state, v)) return { over: true, reason: 'blocked', winner: 1 - seat };
  const key = positionKey(state);
  if (state.seen.filter((k) => k === key).length >= 3) return { over: true, reason: 'repetition', winner: null };
  if (state.quiet >= QUIET_LIMIT) return { over: true, reason: 'quiet', winner: null };
  return { over: false };
}

// How the move reads in the list: "d2", "d2-d3", "d2-d3xg7".
export function moveName(v, { from, to, remove }) {
  const name = (p) => v.points[p].name;
  return `${from === undefined ? '' : `${name(from)}-`}${name(to)}${remove === undefined ? '' : `x${name(remove)}`}`;
}

const SYMBOLS = '.wb';
// The pieces as one character per point: 'w' for seat 0, 'b' for seat 1.
export const boardKey = (board) => board.map((c) => SYMBOLS[c + 1]).join('');

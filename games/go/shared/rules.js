// The rules of Go: placing stones, captures, no suicide, positional superko,
// handicap stones and area scoring. Used by the server to judge moves and by
// the browser to replay them.
//
// Points are numbered y * size + x, with x = 0 on the left and y = 0 on the
// bottom row (row "1"). Each point holds BLACK (seat 0), WHITE (seat 1) or
// EMPTY.

export const SIZES = [9, 13, 19];
export const EMPTY = -1;
export const BLACK = 0;
export const WHITE = 1;
export const KOMI = 7.5;
// With handicap stones White only gets enough to settle a tie.
export const HANDICAP_KOMI = 0.5;
export const MAX_HANDICAP = 9;

// Column letters skip I, which is too easily read as J or 1.
const LETTERS = 'ABCDEFGHJKLMNOPQRST';

export const pointName = (size, point) => LETTERS[point % size] + (Math.floor(point / size) + 1);

export const komiFor = (handicap) => (handicap ? HANDICAP_KOMI : KOMI);

const neighbourCache = new Map();
// The points next to each point, by size.
export function neighbours(size) {
  if (!neighbourCache.has(size)) {
    neighbourCache.set(size, Array.from({ length: size * size }, (_, p) => {
      const x = p % size;
      const list = [];
      if (x > 0) list.push(p - 1);
      if (x < size - 1) list.push(p + 1);
      if (p >= size) list.push(p - size);
      if (p < size * (size - 1)) list.push(p + size);
      return list;
    }));
  }
  return neighbourCache.get(size);
}

// The marked points of the board. They are also where handicap stones go.
function keyPoints(size) {
  const edge = size < 13 ? 2 : 3;
  const lo = edge;
  const hi = size - 1 - edge;
  const mid = (size - 1) / 2;
  const at = (x, y) => y * size + x;
  return {
    corners: [at(hi, hi), at(lo, lo), at(hi, lo), at(lo, hi)],
    sides: [at(lo, mid), at(hi, mid), at(mid, hi), at(mid, lo)],
    centre: at(mid, mid),
  };
}

export function starPoints(size) {
  const { corners, sides, centre } = keyPoints(size);
  return size < 19 ? [...corners, centre] : [...corners, ...sides, centre];
}

// The traditional places for `count` handicap stones: corners first, the
// centre for an odd number, then the sides.
export function handicapPoints(size, count) {
  if (count < 2) return [];
  const { corners, sides, centre } = keyPoints(size);
  const points = corners.slice(0, Math.min(count, 4));
  if (count >= 6) points.push(...sides.slice(0, count >= 8 ? 4 : 2));
  if (count % 2 === 1 && count >= 5) points.push(centre);
  return points;
}

const SYMBOLS = '.xo';
export const boardKey = (board) => board.map((c) => SYMBOLS[c + 1]).join('');

// `handicap` stones for Black, after which White moves first.
export function createGame(size, handicap = 0) {
  const board = new Array(size * size).fill(EMPTY);
  for (const p of handicapPoints(size, handicap)) board[p] = BLACK;
  return {
    size,
    board,
    turn: handicap >= 2 ? WHITE : BLACK,
    // Stones each seat has taken off the board.
    captures: [0, 0],
    // Passes in a row; two end the play.
    passes: 0,
    // Every position so far, for positional superko.
    seen: [boardKey(board)],
  };
}

// The chain of stones at `point` and its liberties.
export function chainAt(board, size, point) {
  const colour = board[point];
  const near = neighbours(size);
  const stones = [point];
  const inChain = new Set(stones);
  const liberties = new Set();
  for (let i = 0; i < stones.length; i++) {
    for (const n of near[stones[i]]) {
      if (board[n] === EMPTY) liberties.add(n);
      else if (board[n] === colour && !inChain.has(n)) {
        inChain.add(n);
        stones.push(n);
      }
    }
  }
  return { stones, liberties };
}

// The position after `move` ({ point } or { pass: true }), or { error }.
export function tryMove(state, move) {
  const { size, turn } = state;
  if (move.pass) return { state: { ...state, turn: 1 - turn, passes: state.passes + 1 } };
  const { point } = move;
  if (!Number.isInteger(point) || point < 0 || point >= size * size) return { error: 'Not a point on the board' };
  if (state.board[point] !== EMPTY) return { error: 'That point is taken' };

  const board = state.board.slice();
  board[point] = turn;
  let taken = 0;
  for (const n of neighbours(size)[point]) {
    if (board[n] !== 1 - turn) continue;
    const chain = chainAt(board, size, n);
    if (chain.liberties.size) continue;
    for (const s of chain.stones) board[s] = EMPTY;
    taken += chain.stones.length;
  }
  if (!chainAt(board, size, point).liberties.size) return { error: 'Suicide is not allowed' };
  const key = boardKey(board);
  if (state.seen.includes(key)) return { error: 'Ko: that would repeat an earlier position' };

  const captures = state.captures.slice();
  captures[turn] += taken;
  return { state: { size, board, turn: 1 - turn, captures, passes: 0, seen: [...state.seen, key] } };
}

// For replaying moves the server has already accepted.
export function applyMove(state, move) {
  const result = tryMove(state, move);
  if (result.error) throw new Error(result.error);
  return result.state;
}

export const isLegal = (state, move) => !tryMove(state, move).error;

// How the move reads in the list: "D4", or "Pass".
export const moveName = (size, move) => (move.pass ? 'Pass' : pointName(size, move.point));

// Area scoring once `dead` stones are taken off: each side's stones plus the
// empty points only it surrounds. `owner` gives each point's owner, or EMPTY
// for points nobody gets (and dead stones count for the side around them).
export function score(state, dead, komi) {
  const { size } = state;
  const deadSet = new Set(dead);
  const board = state.board.map((c, p) => (deadSet.has(p) ? EMPTY : c));
  const owner = board.slice();
  const near = neighbours(size);
  const visited = new Uint8Array(board.length);
  for (let start = 0; start < board.length; start++) {
    if (board[start] !== EMPTY || visited[start]) continue;
    // One empty region and the colours along its border.
    const region = [start];
    visited[start] = 1;
    const borders = new Set();
    for (let i = 0; i < region.length; i++) {
      for (const n of near[region[i]]) {
        if (board[n] !== EMPTY) borders.add(board[n]);
        else if (!visited[n]) {
          visited[n] = 1;
          region.push(n);
        }
      }
    }
    const who = borders.size === 1 ? [...borders][0] : EMPTY;
    for (const p of region) owner[p] = who;
  }
  let black = 0;
  let white = komi;
  for (const o of owner) {
    if (o === BLACK) black++;
    else if (o === WHITE) white++;
  }
  return { owner, black, white, winner: black > white ? BLACK : WHITE };
}

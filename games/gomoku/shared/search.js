// The bot: an alpha-beta search over the most promising moves.
//
// A position is judged by its windows, every row of five points on the
// board: a window holding stones of only one colour is worth more the more
// stones it holds, and one holding both colours is dead. The windows are
// kept up to date as stones are put down and taken back, so judging a
// position costs nothing. The same counts rank the moves: a point is good
// to play if it adds to the player's own windows or spoils the opponent's.
//
// Before anything else the search makes a five if it can and blocks the
// opponent's if it must, so even the weakest level sees those.

import { EMPTY, BLACK, fiveAt, forbiddenReason } from './rules.js';

export const BOT_LEVELS = 8;
// How deep the bot looks (in moves of both sides), how many moves it tries
// at each step, how much it lets chance pick among nearly as good moves,
// and the most time it takes.
const LEVELS = [
  { depth: 1, width: 8, noise: 0.5, ms: 500 },
  { depth: 2, width: 6, noise: 0.25, ms: 800 },
  { depth: 2, width: 10, noise: 0.1, ms: 1000 },
  { depth: 3, width: 10, noise: 0.05, ms: 1500 },
  { depth: 4, width: 10, noise: 0, ms: 2000 },
  { depth: 5, width: 10, noise: 0, ms: 3000 },
  { depth: 6, width: 12, noise: 0, ms: 4000 },
  { depth: 8, width: 12, noise: 0, ms: 6000 },
];
export const levelSettings = (level) => LEVELS[level - 1];

// A window's worth by how many stones of one colour it holds.
const WINDOW_VALUE = [0, 1, 10, 80, 600, 0];
// A point's worth to a player by the stones already in each window through
// it: four means it makes five.
const POINT_VALUE = [1, 6, 40, 400, 100_000];
const WIN = 10_000_000;

const windowCache = new Map();
// Every row of five points, and the rows through each point.
function windowsOf(size) {
  if (!windowCache.has(size)) {
    const rows = [];
    const through = Array.from({ length: size * size }, () => []);
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const endX = x + dx * 4;
          const endY = y + dy * 4;
          if (endX >= size || endY < 0 || endY >= size) continue;
          const points = [0, 1, 2, 3, 4].map((n) => (y + dy * n) * size + x + dx * n);
          for (const p of points) through[p].push(rows.length);
          rows.push(points);
        }
      }
    }
    windowCache.set(size, { rows, through });
  }
  return windowCache.get(size);
}

class Position {
  constructor(state, variant) {
    const { size } = state;
    this.size = size;
    this.variant = variant;
    this.board = state.board.slice();
    this.turn = state.turn;
    const { rows, through } = windowsOf(size);
    this.through = through;
    // Stones of each colour in each window.
    this.counts = [new Uint8Array(rows.length), new Uint8Array(rows.length)];
    // Black's windows minus White's.
    this.total = 0;
    // How many stones are within two points of each point.
    this.near = new Uint8Array(size * size);
    this.stones = 0;
    this.board.forEach((c, p) => {
      if (c === EMPTY) return;
      this.board[p] = EMPTY;
      this.place(p, c);
    });
  }

  windowValue(w) {
    const black = this.counts[0][w];
    const white = this.counts[1][w];
    if (black && white) return 0;
    return black ? WINDOW_VALUE[black] : -WINDOW_VALUE[white];
  }

  place(p, c) {
    for (const w of this.through[p]) {
      this.total -= this.windowValue(w);
      this.counts[c][w]++;
      this.total += this.windowValue(w);
    }
    this.board[p] = c;
    this.stones++;
    this.touch(p, 1);
  }

  remove(p, c) {
    for (const w of this.through[p]) {
      this.total -= this.windowValue(w);
      this.counts[c][w]--;
      this.total += this.windowValue(w);
    }
    this.board[p] = EMPTY;
    this.stones--;
    this.touch(p, -1);
  }

  touch(p, by) {
    const { size } = this;
    const x0 = p % size;
    const y0 = Math.floor(p / size);
    for (let y = Math.max(0, y0 - 2); y <= Math.min(size - 1, y0 + 2); y++) {
      for (let x = Math.max(0, x0 - 2); x <= Math.min(size - 1, x0 + 2); x++) this.near[y * size + x] += by;
    }
  }

  // What playing `p` is worth to `c`: building its own windows, and how
  // much it spoils the other side's.
  pointValue(p, c) {
    let own = 0;
    let theirs = 0;
    for (const w of this.through[p]) {
      const mine = this.counts[c][w];
      const other = this.counts[1 - c][w];
      if (!other) own += POINT_VALUE[mine];
      if (!mine) theirs += POINT_VALUE[other];
    }
    return { own, theirs };
  }

  // Whether `c` playing `p` makes a winning row in this variant.
  makesFive(p, c) {
    this.board[p] = c;
    const five = fiveAt(this.board, this.size, p, this.variant);
    this.board[p] = EMPTY;
    return Boolean(five);
  }

  // Renju's forbidden moves need Black stones on two lines through the
  // point (or five more around it), which `own`, the point's worth to
  // Black, shows; only then is the full check worth making.
  allowed(p, c, own = Infinity) {
    if (this.variant !== 'renju' || c !== BLACK || own < 2 * POINT_VALUE[2]) return true;
    return !forbiddenReason(this.board, this.size, p);
  }

  // The moves worth trying for `c`, best first, or a single winning move.
  // `win` is set when one of them makes five; `forced` when the other side
  // threatens five and the moves are the ways to stop it.
  moves(c, width) {
    const { size } = this;
    if (!this.stones) {
      const centre = ((size - 1) / 2) * size + (size - 1) / 2;
      return { list: [centre] };
    }
    const scored = [];
    const threats = [];
    for (let p = 0; p < size * size; p++) {
      if (this.board[p] !== EMPTY || !this.near[p]) continue;
      const { own, theirs } = this.pointValue(p, c);
      if (own >= POINT_VALUE[4] && this.makesFive(p, c) && this.allowed(p, c, own)) return { list: [p], win: true };
      if (theirs >= POINT_VALUE[4] && this.makesFive(p, 1 - c)) threats.push(p);
      scored.push({ p, own, value: own + theirs * 0.9 });
    }
    if (threats.length) return { list: threats.filter((p) => this.allowed(p, c)), forced: true };
    scored.sort((a, b) => b.value - a.value);
    const list = [];
    for (const { p, own } of scored) {
      if (list.length >= width) break;
      if (this.allowed(p, c, own)) list.push(p);
    }
    return { list };
  }

  // The position as `c` sees it; the side to move has the initiative.
  evaluate(c) {
    return c === BLACK ? this.total : -this.total;
  }
}

class Timeout extends Error {}

// Searches the position for the side to move in `variant` and returns
// { point, score }, the score from that side's view (above WIN / 2 is a
// win it can force). `random` decides between moves nearly as good.
export function search(state, variant, { depth, width, noise = 0, ms = Infinity, random = Math.random }) {
  const pos = new Position(state, variant);
  const me = state.turn;
  const deadline = Date.now() + ms;
  let nodes = 0;

  function negamax(c, left, alpha, beta, ply) {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw new Timeout();
    const { list, win } = pos.moves(c, width);
    if (win) return WIN - ply;
    // No way to stop five, or nowhere left to play.
    if (!list.length) return pos.stones === state.size ** 2 ? 0 : -(WIN - ply - 1);
    if (left === 0) return pos.evaluate(c);
    let best = -Infinity;
    for (const p of list) {
      pos.place(p, c);
      const score = -negamax(1 - c, left - 1, -beta, -alpha, ply + 1);
      pos.remove(p, c);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  const root = pos.moves(me, Math.max(width, 12));
  if (!root.list.length) return null;
  if (root.win || root.list.length === 1) return { point: root.list[0], score: root.win ? WIN : 0 };

  // Deeper and deeper, keeping the last search that finished in time.
  let scores = root.list.map((point) => ({ point, score: 0 }));
  for (let d = 1; d <= depth; d++) {
    try {
      const next = [];
      let alpha = -Infinity;
      for (const { point } of scores) {
        pos.place(point, me);
        // With chance in play every move needs its real score, not just a
        // bound showing it is no better than the best so far.
        const score = -negamax(1 - me, d - 1, -Infinity, noise ? Infinity : -alpha, 1);
        pos.remove(point, me);
        next.push({ point, score });
        if (score > alpha) alpha = score;
      }
      scores = next.sort((a, b) => b.score - a.score);
      if (scores[0].score > WIN / 2) break;
    } catch (err) {
      if (!(err instanceof Timeout)) throw err;
      break;
    }
  }

  // The weaker levels take any move close enough to the best, unless the
  // best wins or the others lose.
  const best = scores[0];
  if (noise && Math.abs(best.score) < WIN / 2) {
    const margin = noise * 400;
    const close = scores.filter((s) => s.score >= best.score - margin && s.score > -WIN / 2);
    return close[Math.floor(random() * close.length)];
  }
  return best;
}

export function chooseMove(state, variant, level, { ms = Infinity, random } = {}) {
  const settings = levelSettings(level);
  return search(state, variant, { ...settings, ms: Math.min(ms, settings.ms), random });
}

// Three stones to open a Swap2 game with (black, white, black), around the
// centre: shapes that leave neither side much ahead.
const OPENINGS = [
  [[0, 0], [1, 1], [2, 0]],
  [[0, 0], [1, 0], [0, 2]],
  [[0, 0], [1, -1], [-1, -1]],
  [[0, 0], [0, 1], [2, 1]],
  [[0, 0], [1, 1], [-1, 2]],
];

export function openingStones(size, random = Math.random) {
  const mid = (size - 1) / 2;
  const shape = OPENINGS[Math.floor(random() * OPENINGS.length)];
  return shape.map(([dx, dy]) => (mid + dy) * size + mid + dx);
}

// Which colour the bot takes when Swap2 lets it choose: the side the search
// likes, looking from White, who moves next.
export function chooseColour(state, variant) {
  const found = search(state, variant, { depth: 3, width: 10, ms: 2000 });
  return found && found.score > 0 ? state.turn : 1 - state.turn;
}

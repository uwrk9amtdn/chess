// A fast board for playing random games to the end, which is how the bot
// judges moves (shared/mcts.js) and how the server guesses which stones are
// dead once both players pass.
//
// The board has a border of edge cells around it, so a point's neighbours
// are always at +1, -1, +W and -W. Colours here are 1 (Black) and 2 (White),
// one more than the seat; 0 is empty and 3 the edge.

import { BLACK, chainAt } from './rules.js';

const EDGE = 3;

// A small seeded random number generator, so a guess can be repeated.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FastBoard {
  constructor(size) {
    const W = size + 2;
    this.size = size;
    this.W = W;
    this.cells = new Uint8Array(W * W).fill(EDGE);
    // The empty points, in no order, and where each is in that list.
    this.empties = new Int32Array(size * size);
    this.emptyAt = new Int32Array(W * W);
    this.emptyCount = 0;
    this.ko = -1;
    this.mark = new Uint32Array(W * W);
    this.gen = 0;
    this.stack = new Int32Array(W * W);
    this.lib = -1; // a liberty found by the last call to liberties()
    for (let p = 0; p < size * size; p++) {
      const i = this.toCell(p);
      this.cells[i] = 0;
      this.addEmpty(i);
    }
  }

  // From a position of shared/rules.js.
  static from(state) {
    const board = new FastBoard(state.size);
    state.board.forEach((c, p) => {
      if (c < 0) return;
      const i = board.toCell(p);
      board.cells[i] = c + 1;
      board.removeEmpty(i);
    });
    return board;
  }

  toCell(point) {
    const x = point % this.size;
    return (Math.floor(point / this.size) + 1) * this.W + x + 1;
  }

  toPoint(i) {
    return (Math.floor(i / this.W) - 1) * this.size + (i % this.W) - 1;
  }

  copyFrom(other) {
    this.cells.set(other.cells);
    this.empties.set(other.empties);
    this.emptyAt.set(other.emptyAt);
    this.emptyCount = other.emptyCount;
    this.ko = other.ko;
  }

  addEmpty(i) {
    this.emptyAt[i] = this.emptyCount;
    this.empties[this.emptyCount++] = i;
  }

  removeEmpty(i) {
    const k = this.emptyAt[i];
    const last = this.empties[--this.emptyCount];
    this.empties[k] = last;
    this.emptyAt[last] = k;
  }

  // The liberties of the chain at `i`, counting no further than `max`. The
  // last one found is left in `this.lib`.
  liberties(i, max) {
    const { cells, mark, stack, W } = this;
    const colour = cells[i];
    const gen = ++this.gen;
    let sp = 0;
    let count = 0;
    stack[sp++] = i;
    mark[i] = gen;
    while (sp) {
      const s = stack[--sp];
      for (const n of [s + 1, s - 1, s + W, s - W]) {
        if (mark[n] === gen) continue;
        const v = cells[n];
        if (v === 0) {
          mark[n] = gen;
          this.lib = n;
          if (++count >= max) return count;
        } else if (v === colour) {
          mark[n] = gen;
          stack[sp++] = n;
        }
      }
    }
    return count;
  }

  removeChain(i) {
    const { cells, stack, W } = this;
    const colour = cells[i];
    let sp = 0;
    let count = 0;
    stack[sp++] = i;
    cells[i] = 0;
    while (sp) {
      const s = stack[--sp];
      this.addEmpty(s);
      count++;
      for (const n of [s + 1, s - 1, s + W, s - W]) {
        if (cells[n] === colour) {
          cells[n] = 0;
          stack[sp++] = n;
        }
      }
    }
    return count;
  }

  // Plays colour `c` at `i`. Returns false, changing nothing, if that is not
  // allowed: taken, suicide, or retaking a ko at once. Longer cycles are not
  // checked here; the rules do that for real moves.
  play(i, c) {
    const { cells, W } = this;
    if (cells[i] !== 0 || i === this.ko) return false;
    const o = 3 - c;
    cells[i] = c;
    let captured = 0;
    let capturedAt = -1;
    for (const n of [i + 1, i - 1, i + W, i - W]) {
      if (cells[n] === o && !this.liberties(n, 1)) {
        captured += this.removeChain(n);
        capturedAt = n;
      }
    }
    if (!captured && !this.liberties(i, 1)) {
      cells[i] = 0;
      return false;
    }
    this.removeEmpty(i);
    this.ko = -1;
    // Taking one stone with a lone stone that is left with one liberty: the
    // other side may not take straight back.
    if (captured === 1) {
      let lone = true;
      let libs = 0;
      for (const n of [i + 1, i - 1, i + W, i - W]) {
        if (cells[n] === c) lone = false;
        else if (cells[n] === 0) libs++;
      }
      if (lone && libs === 1) this.ko = capturedAt;
    }
    return true;
  }

  // An empty point surrounded by `c` that the other side cannot make false.
  isEye(i, c) {
    const { cells, W } = this;
    for (const n of [i + 1, i - 1, i + W, i - W]) {
      if (cells[n] !== c && cells[n] !== EDGE) return false;
    }
    let bad = 0;
    let edge = 0;
    for (const n of [i + W + 1, i + W - 1, i - W + 1, i - W - 1]) {
      if (cells[n] === EDGE) edge = 1;
      else if (cells[n] === 3 - c) bad++;
    }
    return bad + edge < 2;
  }

  // A move for the playouts: take a chain that the last move left in atari,
  // or save one of ours it put in atari, else any point that is not our own
  // eye. -1 is a pass.
  playoutMove(c, last, rng) {
    if (last >= 0) {
      const { cells, W } = this;
      if (cells[last] === 3 - c && this.liberties(last, 2) === 1) {
        const take = this.lib;
        if (this.play(take, c)) return take;
      }
      for (const n of [last + 1, last - 1, last + W, last - W]) {
        if (cells[n] !== c || this.liberties(n, 2) !== 1) continue;
        const escape = this.lib;
        if (this.play(escape, c)) return escape;
      }
    }
    const { empties } = this;
    let n = this.emptyCount;
    while (n > 0) {
      const k = Math.floor(rng() * n);
      const i = empties[k];
      if (!this.isEye(i, c) && this.play(i, c)) return i;
      // Not playable: put it out of the way and pick again among the rest.
      n--;
      const other = empties[n];
      empties[k] = other;
      empties[n] = i;
      this.emptyAt[other] = k;
      this.emptyAt[i] = n;
    }
    return -1;
  }

  // Plays both sides at random until two passes in a row, starting with `c`.
  // `onMove(i, c, ply)` hears every stone played.
  playout(c, rng, last = -1, onMove = null) {
    const limit = this.size * this.size * 3;
    let passes = 0;
    for (let ply = 0; passes < 2 && ply < limit; ply++) {
      const i = this.playoutMove(c, last, rng);
      if (i < 0) passes++;
      else {
        passes = 0;
        onMove?.(i, c, ply);
      }
      last = i;
      c = 3 - c;
    }
  }

  // Who has the point at `i` at the end of a playout: its stone, or the
  // colour all around an empty point; 1 for Black, -1 for White, 0 for nobody.
  ownerOf(i) {
    const { cells, W } = this;
    const v = cells[i];
    if (v === 1) return 1;
    if (v === 2) return -1;
    let around = 0;
    for (const n of [i + 1, i - 1, i + W, i - W]) {
      const m = cells[n];
      if (m === EDGE) continue;
      if (m === 0) return 0;
      around |= m;
    }
    return around === 1 ? 1 : around === 2 ? -1 : 0;
  }

  // Black's area minus White's, without komi.
  score() {
    let total = 0;
    const { size } = this;
    for (let p = 0; p < size * size; p++) total += this.ownerOf(this.toCell(p));
    return total;
  }
}

// How often each point ends up Black's (1) or White's (-1) in random games
// from `state`, from -1 to 1.
export function ownership(state, playouts, rng) {
  const base = FastBoard.from(state);
  const board = new FastBoard(state.size);
  const own = new Float64Array(state.size * state.size);
  for (let k = 0; k < playouts; k++) {
    board.copyFrom(base);
    board.playout(state.turn + 1, rng);
    for (let p = 0; p < own.length; p++) own[p] += board.ownerOf(board.toCell(p));
  }
  return own.map((v) => v / playouts);
}

const GUESS_PLAYOUTS = { 9: 600, 13: 400, 19: 250 };

// The stones that look dead when play ends: whole chains that the other side
// wins in most random games from here. The players can correct it.
export function guessDead(state) {
  const { size, board } = state;
  const own = ownership(state, GUESS_PLAYOUTS[size] ?? 250, mulberry32(12345));
  const dead = [];
  const seen = new Set();
  for (let p = 0; p < board.length; p++) {
    if (board[p] < 0 || seen.has(p)) continue;
    const { stones } = chainAt(board, size, p);
    for (const s of stones) seen.add(s);
    const sign = board[p] === BLACK ? 1 : -1;
    const mine = stones.reduce((sum, s) => sum + own[s] * sign, 0) / stones.length;
    // Clearly the other side's; anything closer, such as a seki, lives.
    if (mine < -0.3) dead.push(...stones);
  }
  return dead.sort((a, b) => a - b);
}

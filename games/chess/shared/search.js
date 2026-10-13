// A chess player built on the rules in engine.js: it looks a few moves ahead
// and counts what is left. Like the rules, it reads everything from the
// variant definition, so it plays every variant, none of them well. It runs
// in the browser of whoever plays against it (see client/bot).

import { legalMoves, applyLegal, status, seatToMove, teamOf } from './engine.js';

const MATE = 100_000;
const VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
// How much a piece gains from standing near the middle, per step closer.
const CENTRE = { n: 8, b: 4, q: 2, k: 0, r: 0, p: 2 };
// Captures are followed this many moves past the depth asked for, so that a
// search does not stop in the middle of an exchange.
const QUIET_DEPTH = 3;
const TIMEOUT = Symbol('timeout');

// What a level means to search(): how deep to look, for how long at most,
// and how many hundredths of a pawn its judgement is off by.
const LEVELS = [
  { depth: 1, timeMs: 1000, noise: 300 },
  { depth: 1, timeMs: 1000, noise: 150 },
  { depth: 2, timeMs: 1000, noise: 100 },
  { depth: 2, timeMs: 1000, noise: 40 },
  { depth: 3, timeMs: 1000, noise: 20 },
  { depth: 4, timeMs: 1500, noise: 0 },
  { depth: 6, timeMs: 2500, noise: 0 },
  { depth: 64, timeMs: 4000, noise: 0 },
];

export const levelSettings = (level) => LEVELS[level - 1];

// How good the position is for `team`, in hundredths of a pawn.
export function evaluate(state, team) {
  const { variant, board } = state;
  const w = variant.width;
  const h = variant.height;
  const giveaway = variant.royal === false;
  const kings = [];
  let score = 0;

  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p) continue;
    const sign = teamOf(variant, p.seat) === team ? 1 : -1;
    // Where the aim is to lose everything, every piece is a burden.
    if (giveaway) {
      score -= sign * 100;
      continue;
    }
    const x = i % w;
    const y = (i - x) / w;
    let value = VALUES[p.type];
    value -= CENTRE[p.type] * (Math.abs(2 * x - (w - 1)) + Math.abs(2 * y - (h - 1))) * (4 / w);
    if (p.type === 'p') {
      const [fx, fy] = variant.seats[p.seat].forward;
      const rank = fy > 0 ? y : fy < 0 ? h - 1 - y : fx > 0 ? x : w - 1 - x;
      value += (60 * rank) / (h - 1);
    } else if (p.type === 'k') {
      kings.push({ x, y, sign });
    }
    score += sign * value;
  }

  for (const king of kings) {
    // A king that wins by getting somewhere should be on its way.
    if (variant.hill) {
      const far = Math.min(...variant.hill.map((sq) => Math.max(Math.abs((sq % w) - king.x), Math.abs(Math.floor(sq / w) - king.y))));
      score -= king.sign * far * 50;
    }
    if (variant.goalRank !== undefined) score -= king.sign * Math.abs(variant.goalRank - king.y) * 90;
    // Where captures explode, pieces close to a king are a threat to it.
    if (variant.explosions) {
      for (let y = Math.max(0, king.y - 2); y <= Math.min(h - 1, king.y + 2); y++) {
        for (let x = Math.max(0, king.x - 2); x <= Math.min(w - 1, king.x + 2); x++) {
          const p = board[y * w + x];
          if (p && p.type !== 'k' && p.type !== 'p' && (teamOf(variant, p.seat) === team ? 1 : -1) !== king.sign) {
            score -= king.sign * 12;
          }
        }
      }
    }
  }

  if (state.checks) state.checks.forEach((given, t) => { score += (t === team ? 1 : -1) * given * 350; });
  if (state.pockets) {
    state.pockets.forEach((pocket, seat) => {
      const sign = teamOf(variant, seat) === team ? 1 : -1;
      for (const type in pocket) score += sign * pocket[type] * VALUES[type];
    });
  }
  return score;
}

// Most promising first: the biggest capture by the smallest piece, then
// promotions. The better this guess, the more the search can skip.
function order(state, moves) {
  const { board } = state;
  const weight = (m) => {
    let v = 0;
    if (m.capture !== undefined) v += 10 * VALUES[board[m.capture].type] - VALUES[board[m.from].type] + 10_000;
    if (m.promotion) v += VALUES[m.promotion];
    return v;
  };
  for (const m of moves) m.weight = weight(m);
  return moves.sort((a, b) => b.weight - a.weight);
}

const noisy = (m) => m.capture !== undefined || Boolean(m.promotion);

// The same position for the third time, or too long without progress.
function drawn(state) {
  if (state.halfmove >= 50 * state.variant.turnOrder.length) return true;
  const { history } = state;
  const key = history[history.length - 1];
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) if (history[i] === key && ++seen === 3) return true;
  return false;
}

// Picks a move for the seat to move: { move, score, depth }, or null when
// there is none. `move` is one of legalMoves(state) and `score` what the
// search thinks of it for the mover, in hundredths of a pawn. It looks
// `depth` moves ahead, or as far as it gets in `timeMs` (the first move ahead
// is always finished, however long it takes). `noise` is how far off, at
// most, its opinion of each move is: that is what makes a weak player.
export function search(state, { depth: maxDepth = 64, timeMs = 1000, noise = 0, now = Date.now, random = Math.random } = {}) {
  const { variant } = state;
  const deadline = now() + timeMs;
  let timed = false;

  // What the side to move can count on, between `alpha` and `beta`. Below
  // depth 0 only captures and promotions are tried, and the mover may stop.
  function value(pos, depth, alpha, beta, ply) {
    if (timed && now() > deadline) throw TIMEOUT;
    const team = teamOf(variant, seatToMove(pos));
    let moves = legalMoves(pos);
    if (!moves.length) {
      const { winner } = status(pos);
      if (winner === null) return 0;
      // The sooner a win and the later a loss, the better.
      return winner === team ? MATE - ply : ply - MATE;
    }
    if (drawn(pos)) return 0;
    let best = -Infinity;
    if (depth <= 0) {
      best = evaluate(pos, team);
      if (depth <= -QUIET_DEPTH || best >= beta) return best;
      if (best > alpha) alpha = best;
      moves = moves.filter(noisy);
    }
    for (const move of order(pos, moves)) {
      const score = after(pos, move, team, depth, alpha, beta, ply);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  // What `team` can count on once it has played the move. The next mover is
  // an opponent unless the variant gives a team two turns in a row.
  function after(pos, move, team, depth, alpha, beta, ply) {
    const next = applyLegal(pos, move);
    if (teamOf(variant, seatToMove(next)) === team) return value(next, depth - 1, alpha, beta, ply + 1);
    return -value(next, depth - 1, -beta, -alpha, ply + 1);
  }

  const team = teamOf(variant, seatToMove(state));
  const moves = order(state, legalMoves(state));
  if (!moves.length) return null;
  let best = { move: moves[0], score: 0, depth: 0 };

  for (let depth = 1; depth <= maxDepth; depth++) {
    timed = depth > 1;
    let chosen = null;
    try {
      let alpha = -Infinity;
      let top = -Infinity;
      for (const move of moves) {
        // A player whose judgement is off needs each move's true worth to
        // misjudge; otherwise it is enough to know a move is no better.
        const score = after(state, move, team, depth, noise ? -Infinity : alpha, Infinity, 0);
        if (score > alpha) alpha = score;
        // A forced win or loss is seen for what it is at any level.
        const seen = noise && Math.abs(score) < MATE / 2 ? score + (random() * 2 - 1) * noise : score;
        if (seen > top) {
          top = seen;
          chosen = { move, score, depth };
        }
      }
    } catch (err) {
      if (err !== TIMEOUT) throw err;
      break;
    }
    best = chosen;
    // The move that looked best is tried first when looking deeper.
    moves.splice(moves.indexOf(best.move), 1);
    moves.unshift(best.move);
    // Stop when the game is decided, there is no choice, or another round
    // would not be finished in time.
    if (Math.abs(best.score) > MATE / 2 || moves.length === 1 || now() - (deadline - timeMs) > timeMs / 3) break;
  }
  return best;
}

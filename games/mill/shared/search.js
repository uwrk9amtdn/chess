// The bot: an alpha-beta search to a depth set by its level, judging the
// positions it reaches by pieces, mills, mills about to close and how
// freely each side can move. The rules say when a game has been won or
// drawn, so the search sees those too.

import { legalMoves, play, status, targets, EMPTY } from './rules.js';

export const BOT_LEVELS = 8;
// How deep the bot looks (in moves of both sides), how much it lets chance
// pick among nearly as good moves, and the most time it takes.
const LEVELS = [
  { depth: 1, noise: 0.6, ms: 400 },
  { depth: 2, noise: 0.3, ms: 600 },
  { depth: 2, noise: 0.1, ms: 800 },
  { depth: 3, noise: 0.05, ms: 1200 },
  { depth: 4, noise: 0, ms: 1800 },
  { depth: 5, noise: 0, ms: 2500 },
  { depth: 6, noise: 0, ms: 3500 },
  { depth: 8, noise: 0, ms: 5000 },
];
export const levelSettings = (level) => LEVELS[level - 1];

const WIN = 1_000_000;

// The position as the side to move sees it.
export function evaluate(state, v) {
  const me = state.turn;
  const sign = (seat) => (seat === me ? 1 : -1);
  let score = 0;
  for (const seat of [0, 1]) score += sign(seat) * 100 * (state.inHand[seat] + state.onBoard[seat]);
  // Closed mills, and two in a line with the third point free.
  for (const mill of v.mills) {
    let mine = 0;
    let theirs = 0;
    let empty = 0;
    for (const p of mill) {
      if (state.board[p] === me) mine++;
      else if (state.board[p] === EMPTY) empty++;
      else theirs++;
    }
    if (mine === 3) score += 15;
    if (theirs === 3) score -= 15;
    if (mine === 2 && empty === 1) score += 10;
    if (theirs === 2 && empty === 1) score -= 10;
  }
  // Room to move, once pieces move along the lines.
  for (const seat of [0, 1]) {
    if (state.inHand[seat]) continue;
    let moves = 0;
    state.board.forEach((c, p) => {
      if (c === seat) moves += Math.min(4, targets(state, v, p).length);
    });
    score += sign(seat) * 3 * moves;
  }
  return score;
}

class Timeout extends Error {}

// Taking pieces first: they are the moves most likely to be best.
const ordered = (moves) => moves.sort((a, b) => (b.remove !== undefined) - (a.remove !== undefined));

// Searches the position for the side to move in variant `v` and returns
// { move, score }, the score from that side's view (above WIN / 2 is a win
// it can force). `random` decides between moves nearly as good.
export function search(state, v, { depth, noise = 0, ms = Infinity, random = Math.random }) {
  const deadline = Date.now() + ms;
  let nodes = 0;

  function negamax(s, left, alpha, beta, ply) {
    if ((++nodes & 255) === 0 && Date.now() > deadline) throw new Timeout();
    const result = status(s, v);
    if (result.over) {
      if (result.winner === null) return 0;
      return result.winner === s.turn ? WIN - ply : -(WIN - ply);
    }
    if (left === 0) return evaluate(s, v);
    let best = -Infinity;
    for (const move of ordered(legalMoves(s, v))) {
      const score = -negamax(play(s, v, move), left - 1, -beta, -alpha, ply + 1);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  const moves = ordered(legalMoves(state, v));
  if (!moves.length) return null;
  if (moves.length === 1) return { move: moves[0], score: 0 };

  // Deeper and deeper, keeping the last search that finished in time.
  let scores = moves.map((move) => ({ move, score: 0 }));
  for (let d = 1; d <= depth; d++) {
    try {
      const next = [];
      let alpha = -Infinity;
      for (const { move } of scores) {
        // With chance in play every move needs its real score, not just a
        // bound showing it is no better than the best so far.
        const score = -negamax(play(state, v, move), d - 1, -Infinity, noise ? Infinity : -alpha, 1);
        next.push({ move, score });
        if (score > alpha) alpha = score;
      }
      scores = next.sort((a, b) => b.score - a.score);
      if (Math.abs(scores[0].score) > WIN / 2) break;
    } catch (err) {
      if (!(err instanceof Timeout)) throw err;
      break;
    }
  }

  // The weaker levels take any move close enough to the best, unless the
  // best wins or the others lose.
  const best = scores[0];
  if (noise && Math.abs(best.score) < WIN / 2) {
    const margin = noise * 150;
    const close = scores.filter((s) => s.score >= best.score - margin && s.score > -WIN / 2);
    return close[Math.floor(random() * close.length)];
  }
  return best;
}

export function chooseMove(state, v, level, { ms = Infinity, random } = {}) {
  const settings = levelSettings(level);
  return search(state, v, { ...settings, ms: Math.min(ms, settings.ms), random });
}

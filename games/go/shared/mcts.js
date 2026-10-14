// The bot: a Monte-Carlo tree search with RAVE. It plays many random games
// from the position (see playout.js), keeps a tree of the moves that did
// best, and plays the one it tried most. Higher levels play more games.

import { FastBoard, mulberry32 } from './playout.js';
import { BLACK, tryMove } from './rules.js';

export const BOT_LEVELS = 8;
// Random games per move, and the most time the bot may take for them.
const LEVELS = [
  { playouts: 40, ms: 400 },
  { playouts: 120, ms: 700 },
  { playouts: 300, ms: 1000 },
  { playouts: 800, ms: 1500 },
  { playouts: 2000, ms: 2500 },
  { playouts: 5000, ms: 4000 },
  { playouts: 12000, ms: 6000 },
  { playouts: 30000, ms: 10000 },
];
export const levelSettings = (level) => LEVELS[level - 1];

// How much the moves' all-moves-as-first statistics count, against their own.
const RAVE_K = 600;
// A point is settled when random games give it to one side this reliably.
const SETTLED = 0.8;

class Node {
  constructor(move, colour, prior) {
    this.move = move; // board cell, as in FastBoard
    this.colour = colour; // who played it
    this.children = null;
    // Wins are counted for `colour`, starting from a guess worth a few games.
    this.n = prior.n;
    this.w = prior.w;
    this.rn = 0;
    this.rw = 0;
    this.visits = 0;
  }

  value() {
    const q = this.w / this.n;
    if (!this.rn) return q;
    const beta = Math.sqrt(RAVE_K / (3 * this.n + RAVE_K));
    return (1 - beta) * q + beta * (this.rw / this.rn);
  }
}

// What a move is guessed to be worth before trying it: taking stones is
// usually good, and while the board is open the third and fourth lines are
// where play starts, the first two seldom.
function prior(board, i, colour, open) {
  const { W, size, cells } = board;
  for (const n of [i + 1, i - 1, i + W, i - W]) {
    if (cells[n] === 3 - colour && board.liberties(n, 2) === 1) return { n: 12, w: 11 };
  }
  const x = (i % W) - 1;
  const y = Math.floor(i / W) - 1;
  const line = Math.min(x, y, size - 1 - x, size - 1 - y);
  if (open && line === 0) return { n: 12, w: 2 };
  if (open && line === 1) return { n: 12, w: 4 };
  if (open && size >= 13 && (line === 2 || line === 3)) return { n: 12, w: 7 };
  return { n: 2, w: 1 };
}

function expand(node, board, colour) {
  const open = board.emptyCount > board.size * board.size * 0.6;
  node.children = [];
  for (let k = 0; k < board.emptyCount; k++) {
    const i = board.empties[k];
    if (i !== board.ko && !board.isEye(i, colour)) node.children.push(new Node(i, colour, prior(board, i, colour, open)));
  }
}

function select(node) {
  let best = null;
  let bestValue = -Infinity;
  for (const child of node.children) {
    const v = child.value();
    if (v > bestValue) {
      bestValue = v;
      best = child;
    }
  }
  return best;
}

// Searches the position and returns { move, winrate, ownership }: the move
// as { point } or { pass: true }, how often the bot won after it, and who
// ends up with each point (1 Black, -1 White).
export function search(state, { komi, playouts, timeMs, random = Math.random }) {
  const root = FastBoard.from(state);
  const { size, W } = root;
  const colour = state.turn + 1;
  const rootNode = new Node(-1, 3 - colour, { n: 1, w: 0 });
  expand(rootNode, root, colour);
  const own = new Float64Array(size * size);
  // For RAVE: the colour that first played each cell in a game, and when.
  const firstColour = new Uint8Array(W * W);
  const firstPly = new Int32Array(W * W);
  const board = new FastBoard(size);
  const seed = Math.floor(random() * 2 ** 32);
  const rng = mulberry32(seed);
  const deadline = Date.now() + timeMs;

  let games = 0;
  for (; games < playouts && (games % 64 || Date.now() < deadline); games++) {
    board.copyFrom(root);
    firstColour.fill(0);
    const path = [rootNode];
    let node = rootNode;
    let c = colour;
    let ply = 0;
    let last = -1;
    const record = (i, who, at) => {
      if (!firstColour[i]) {
        firstColour[i] = who;
        firstPly[i] = at;
      }
    };
    // Down the tree, growing it by one level where a node has been visited.
    for (;;) {
      if (!node.children) {
        if (!node.visits) break;
        expand(node, board, c);
      }
      if (!node.children.length) break;
      const child = select(node);
      if (!board.play(child.move, c)) {
        node.children.splice(node.children.indexOf(child), 1);
        continue;
      }
      record(child.move, c, ply++);
      last = child.move;
      path.push(child);
      node = child;
      c = 3 - c;
    }
    board.playout(c, rng, last, (i, who, at) => record(i, who, ply + at));

    const blackWins = board.score() - komi > 0;
    const winner = blackWins ? 1 : 2;
    for (let p = 0; p < own.length; p++) own[p] += board.ownerOf(board.toCell(p));
    path.forEach((n, depth) => {
      n.visits++;
      n.n++;
      if (n.colour === winner) n.w++;
      // Every move of a child's colour played later in this game counts a
      // little for that child.
      if (!n.children) return;
      for (const child of n.children) {
        const i = child.move;
        if (firstColour[i] !== child.colour || firstPly[i] < depth) continue;
        child.rn++;
        if (child.colour === winner) child.rw++;
      }
    });
  }

  const ownership = Array.from(own, (v) => v / Math.max(1, games));
  // The real rules also forbid repeating any earlier position.
  const tried = rootNode.children
    .filter((child) => child.visits)
    .sort((a, b) => b.visits - a.visits)
    .map((child) => ({ point: root.toPoint(child.move), winrate: child.w / child.n }));
  const pick = tried.find(({ point }) => !tryMove(state, { point }).error);
  if (!pick || shouldPass(state, root, colour, ownership, komi)) {
    return { move: { pass: true }, winrate: pick?.winrate ?? 0.5, ownership, games };
  }
  return { move: { point: pick.point }, winrate: pick.winrate, ownership, games };
}

// Passing makes sense when nothing is left to fight over, or when the other
// side has passed and the bot is ahead as things stand.
function shouldPass(state, board, colour, ownership, komi) {
  const sign = colour === BLACK + 1 ? 1 : -1;
  const unsettled = [];
  for (let k = 0; k < board.emptyCount; k++) {
    const i = board.empties[k];
    if (!board.isEye(i, colour) && Math.abs(ownership[board.toPoint(i)]) < SETTLED) unsettled.push(i);
  }
  if (!unsettled.length) return true;
  if (state.passes === 0) return false;
  const lead = ownership.reduce((sum, v) => sum + Math.sign(Math.round(v * 2) / 2), 0) - komi;
  return lead * sign > 0;
}

export function chooseMove(state, { komi, level, timeMs = Infinity, random }) {
  const settings = levelSettings(level);
  return search(state, { komi, playouts: settings.playouts, timeMs: Math.min(timeMs, settings.ms), random });
}

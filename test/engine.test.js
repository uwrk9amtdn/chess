import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, legalMoves, applyMove, status, toSan, findMove, fromFEN,
} from '../shared/engine.js';
import { standard, double, facingSetup } from '../shared/variants.js';

function perft(state, depth) {
  const moves = legalMoves(state);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const m of moves) nodes += perft(applyMove(state, m), depth - 1);
  return nodes;
}

const sq = (name) => (Number(name.slice(1)) - 1) * 8 + name.charCodeAt(0) - 97;

// Plays moves written as "e2e4" or "e7e8q".
function playAll(state, moves) {
  for (const m of moves.split(' ')) {
    state = applyMove(state, { from: sq(m.slice(0, 2)), to: sq(m.slice(2, 4)), promotion: m[4] });
    assert.ok(state, `move ${m} should be legal`);
  }
  return state;
}

// Reference node counts from https://www.chessprogramming.org/Perft_Results
const PERFT = [
  ['start position', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['en passant pins', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['promotions', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
];

for (const [name, fen, counts] of PERFT) {
  test(`perft: ${name}`, () => {
    const state = fromFEN(fen, standard);
    counts.forEach((expected, i) => assert.equal(perft(state, i + 1), expected, `depth ${i + 1}`));
  });
}

test('createGame matches the FEN start position', () => {
  assert.deepEqual(createGame(standard).board, fromFEN(PERFT[0][1], standard).board);
});

test('checkmate', () => {
  const state = playAll(createGame(standard), 'f2f3 e7e5 g2g4 d8h4');
  assert.deepEqual(status(state), { over: true, reason: 'checkmate', winner: 1, check: true });
});

test('stalemate', () => {
  const s = status(fromFEN('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', standard));
  assert.deepEqual(s, { over: true, reason: 'stalemate', winner: null, check: false });
});

test('threefold repetition', () => {
  const shuffle = 'g1f3 g8f6 f3g1 f6g8';
  let state = playAll(createGame(standard), shuffle);
  assert.equal(status(state).over, false);
  state = playAll(state, shuffle);
  assert.equal(status(state).reason, 'repetition');
});

test('fifty-move rule', () => {
  assert.equal(status(fromFEN('4k3/8/8/8/8/8/8/R3K3 w - - 99 80', standard)).over, false);
  assert.equal(status(fromFEN('4k3/8/8/8/8/8/8/R3K3 w - - 100 80', standard)).reason, 'fifty');
});

test('insufficient material', () => {
  assert.equal(status(fromFEN('8/8/4k3/8/8/3K4/8/8 w - - 0 1', standard)).reason, 'material');
  assert.equal(status(fromFEN('8/8/4k3/8/8/3KN3/8/8 w - - 0 1', standard)).reason, 'material');
  assert.equal(status(fromFEN('8/8/4k3/8/8/3KP3/8/8 w - - 0 1', standard)).over, false);
});

test('illegal moves are rejected', () => {
  const state = createGame(standard);
  assert.equal(applyMove(state, { from: sq('e2'), to: sq('e5') }), null);
  assert.equal(applyMove(state, { from: sq('e7'), to: sq('e5') }), null);
  assert.equal(applyMove(state, { from: 'e2', to: sq('e4') }), null);
  // A promotion needs the piece to be named.
  const promo = fromFEN('8/4P3/8/8/8/k7/8/4K3 w - - 0 1', standard);
  assert.equal(applyMove(promo, { from: sq('e7'), to: sq('e8') }), null);
  assert.ok(applyMove(promo, { from: sq('e7'), to: sq('e8'), promotion: 'q' }));
});

test('algebraic notation', () => {
  const san = (state, m) => toSan(state, findMove(state, { from: sq(m.slice(0, 2)), to: sq(m.slice(2, 4)), promotion: m[4] }));
  const start = createGame(standard);
  assert.equal(san(start, 'e2e4'), 'e4');
  assert.equal(san(start, 'g1f3'), 'Nf3');
  assert.equal(san(playAll(start, 'f2f3 e7e5 g2g4'), 'd8h4'), 'Qh4#');
  const kiwipete = fromFEN(PERFT[1][1], standard);
  assert.equal(san(kiwipete, 'e1g1'), 'O-O');
  assert.equal(san(kiwipete, 'e1c1'), 'O-O-O');
  assert.equal(san(kiwipete, 'd5e6'), 'dxe6');
  assert.equal(san(fromFEN('3k4/8/8/8/8/8/4K3/R6R w - - 0 1', standard), 'a1d1'), 'Rad1+');
  assert.equal(san(fromFEN('8/4P3/8/8/8/k7/8/4K3 w - - 0 1', standard), 'e7e8n'), 'e8=N');
});

test('the engine is not tied to 8x8', () => {
  const wide = {
    ...standard,
    id: 'wide',
    width: 10,
    setup: facingSetup(['r', 'n', 'b', 'b', 'q', 'k', 'b', 'b', 'n', 'r'], 8),
  };
  const state = createGame(wide);
  assert.equal(perft(state, 1), 24);
  assert.equal(perft(state, 2), 576);

  // A lone rook on a1 can run the whole 10-square rank and the whole file.
  const open = { ...wide, setup: [
    { type: 'r', seat: 0, x: 0, y: 0 }, { type: 'k', seat: 0, x: 5, y: 3 },
    { type: 'k', seat: 1, x: 9, y: 7 },
  ] };
  const targets = legalMoves(createGame(open), 0).map((m) => m.to);
  assert.ok(targets.includes(9));
  assert.ok(targets.includes(70));
  assert.equal(targets.length, 9 + 7);
});

test('double 16x16: two armies each', () => {
  const state = createGame(double);
  const count = (type, seat) => state.board.filter((p) => p && p.type === type && p.seat === seat).length;
  assert.deepEqual([count('k', 0), count('q', 0), count('k', 1), count('q', 1)], [2, 2, 2, 2]);
  assert.equal(count('p', 0), 16);
  // 16 pawns with two moves each plus four knights with two moves each.
  assert.equal(perft(state, 1), 40);
  assert.equal(perft(state, 2), 1600);
});

test('with two kings, mating either one ends the game', () => {
  const position = (extra) => createGame({ ...standard, id: 'twoKings', setup: [
    { type: 'k', seat: 0, x: 0, y: 0 }, { type: 'p', seat: 0, x: 0, y: 1 }, { type: 'p', seat: 0, x: 1, y: 1 },
    { type: 'k', seat: 0, x: 4, y: 3 },
    { type: 'k', seat: 1, x: 7, y: 7 }, { type: 'k', seat: 1, x: 6, y: 7 },
    ...extra,
  ] });
  assert.equal(status(position([])).over, false);
  // A rook on h1 mates the king on a1; the free king on e4 cannot help.
  const mated = position([{ type: 'r', seat: 1, x: 7, y: 0 }]);
  assert.deepEqual(status(mated), { over: true, reason: 'checkmate', winner: 1, check: true });
  // A rook on h4 only checks the e4 king, which can step away, but the other
  // king may not move while its partner is in check.
  const checked = position([{ type: 'r', seat: 1, x: 7, y: 3 }]);
  assert.equal(status(checked).over, false);
  assert.ok(legalMoves(checked).every((m) => m.from === 3 * 8 + 4));
});

test('castling notation names the king when there are two', () => {
  const s = createGame({ ...double, setup: [
    { type: 'k', seat: 0, x: 4, y: 0 }, { type: 'r', seat: 0, x: 7, y: 0 },
    { type: 'k', seat: 0, x: 12, y: 0 }, { type: 'r', seat: 0, x: 15, y: 0 },
    { type: 'k', seat: 1, x: 4, y: 15 }, { type: 'k', seat: 1, x: 12, y: 15 },
  ] });
  assert.equal(toSan(s, findMove(s, { from: 4, to: 6 })), 'O-O(e)');
  assert.equal(toSan(s, findMove(s, { from: 12, to: 14 })), 'O-O(m)');
});

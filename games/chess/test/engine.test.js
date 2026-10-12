import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, legalMoves, legalDrops, applyMove, status, toSan, findMove, fromFEN, premoveTargets, inCheck,
  canWinOnTime,
} from '../shared/engine.js';
import {
  standard, double, facingSetup, chess960, kingOfTheHill, threeCheck, antichess, atomic, horde, racingKings,
  crazyhouse, variants,
} from '../shared/variants.js';
import { chess960Rank } from '../shared/chess960.js';

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

test('premove targets follow the geometry of the piece, not the position', () => {
  const start = createGame(standard);
  const names = (from) => premoveTargets(start, sq(from)).map((i) => String.fromCharCode(97 + (i % 8)) + (Math.floor(i / 8) + 1)).sort();
  // The rook sees through its own pawn and knight.
  assert.deepEqual(names('a1'), ['a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'b1', 'c1', 'd1', 'e1', 'f1', 'g1', 'h1']);
  // A pawn may be about to capture on either side.
  assert.deepEqual(names('e2'), ['d3', 'e3', 'e4', 'f3']);
  assert.deepEqual(names('e7'), ['d6', 'e5', 'e6', 'f6']);
  // The king's steps plus both castling squares.
  assert.deepEqual(names('e1'), ['c1', 'd1', 'd2', 'e2', 'f1', 'f2', 'g1']);
  assert.deepEqual(names('g8'), ['e7', 'f6', 'h6']);
  assert.deepEqual(names('e4'), []);
});

// ---- variants ----

// Node counts from the start position, as published for each variant (they
// are the figures the Lichess and Fairy-Stockfish move generators agree on).
const VARIANT_PERFT = [
  [chess960, [20, 400, 8902, 197281]],
  [kingOfTheHill, [20, 400, 8902, 197281]],
  [threeCheck, [20, 400, 8902, 197281]],
  [crazyhouse, [20, 400, 8902, 197281]],
  [atomic, [20, 400, 8902, 197326]],
  [antichess, [20, 400, 8067, 153299]],
  [horde, [8, 128, 1274, 23310]],
  [racingKings, [21, 421, 11264, 296242]],
];

for (const [variant, counts] of VARIANT_PERFT) {
  test(`perft: ${variant.name}`, () => {
    counts.forEach((expected, i) => assert.equal(perft(createGame(variant), i + 1), expected, `depth ${i + 1}`));
  });
}

test('every variant has what the list of variants shows', () => {
  for (const v of Object.values(variants)) assert.ok(v.name && v.icon && v.description, v.id);
  assert.equal(Object.keys(variants).length, 10);
});

test('chess960: the 960 starting positions', () => {
  const seen = new Set();
  for (let n = 0; n < 960; n++) {
    const rank = chess960Rank(n);
    const files = (type) => rank.flatMap((t, x) => (t === type ? [x] : []));
    assert.deepEqual([...rank].sort().join(''), 'bbknnqrr');
    assert.notEqual(files('b')[0] % 2, files('b')[1] % 2, `bishops of position ${n}`);
    assert.ok(files('r')[0] < files('k')[0] && files('k')[0] < files('r')[1], `king of position ${n}`);
    seen.add(rank.join(''));
  }
  assert.equal(seen.size, 960);
  assert.equal(chess960Rank(518).join(''), 'rnbqkbnr');
  assert.deepEqual(createGame(chess960).board, createGame(standard).board);
  assert.notDeepEqual(createGame(chess960, 0).board, createGame(standard).board);
});

test('chess960: castling is the king going to its rook', () => {
  // King on b1: it ends on c1 or g1 all the same, the rook on d1 or f1.
  const state = fromFEN('4k3/8/8/8/8/8/8/RK5R w KQ - 0 1', chess960);
  const long = findMove(state, { from: sq('b1'), to: sq('a1') });
  const short = findMove(state, { from: sq('b1'), to: sq('h1') });
  assert.deepEqual([toSan(state, long), toSan(state, short)], ['O-O-O', 'O-O']);
  const types = (s, ...names) => names.map((n) => s.board[sq(n)]?.type ?? '-').join('');
  assert.equal(types(applyMove(state, long), 'a1', 'b1', 'c1', 'd1'), '--kr');
  assert.equal(types(applyMove(state, short), 'b1', 'f1', 'g1', 'h1'), '-rk-');
  assert.ok(premoveTargets(state, sq('b1')).includes(sq('h1')));

  // King and rook next to each other simply change places.
  const swap = createGame({ ...chess960, setupFor: null, setup: [
    { type: 'k', seat: 0, x: 5, y: 0 }, { type: 'r', seat: 0, x: 6, y: 0 }, { type: 'k', seat: 1, x: 0, y: 7 },
  ] });
  assert.equal(types(applyMove(swap, { from: sq('f1'), to: sq('g1') }), 'f1', 'g1'), 'rk');

  // Not through a piece, and not across an attacked square.
  assert.equal(findMove(fromFEN('k7/8/8/8/8/8/8/RK3N1R w KQ - 0 1', chess960), { from: sq('b1'), to: sq('h1') }), null);
  assert.equal(findMove(fromFEN('k3r3/8/8/8/8/8/8/RK5R w KQ - 0 1', chess960), { from: sq('b1'), to: sq('h1') }), null);
});

test('king of the hill: a king in the centre wins', () => {
  const state = fromFEN('7k/8/8/8/8/3K4/8/8 w - - 0 1', kingOfTheHill);
  assert.equal(status(state).over, false);
  const won = applyMove(state, { from: sq('d3'), to: sq('d4') });
  assert.deepEqual(status(won), { over: true, reason: 'hill', winner: 0, check: false });
  assert.deepEqual(legalMoves(won), []);
});

test('three-check: the third check wins', () => {
  let state = playAll(createGame(threeCheck), 'e2e4 f7f6 d1h5 g7g6 h5g6');
  assert.deepEqual(state.checks, [2, 0]);
  assert.equal(status(state).over, false);
  state = playAll(state, 'h7g6 f1b5 a7a6 b5d7');
  assert.deepEqual(status(state), { over: true, reason: 'checks', winner: 0, check: true });
});

test('antichess: captures are forced and running out of pieces wins', () => {
  const state = playAll(createGame(antichess), 'e2e3 b7b5');
  assert.deepEqual(legalMoves(state).map((m) => toSan(state, m)), ['Bxb5']);
  assert.equal(legalMoves(state, sq('g1')).length, 0);
  // There is no check, no castling, and a pawn may become a king.
  const open = fromFEN('r3k2r/8/8/8/8/8/P6p/R3K2R w KQkq - 0 1', antichess);
  assert.equal(inCheck(open, 0), false);
  assert.ok(legalMoves(open).every((m) => !m.castle));
  assert.ok(applyMove(fromFEN('8/P7/8/8/8/8/8/7r w - - 0 1', antichess), { from: sq('a7'), to: sq('a8'), promotion: 'k' }));
  assert.deepEqual(status(fromFEN('8/8/8/8/8/8/8/7r w - - 0 1', antichess)),
    { over: true, reason: 'antichess', winner: 0, check: false });
  // So does being left with no move.
  assert.equal(status(fromFEN('8/8/8/8/8/7p/7P/8 w - - 0 1', antichess)).winner, 0);
});

test('atomic: captures explode', () => {
  let state = playAll(createGame(atomic), 'g1f3 e7e5 f3e5');
  assert.equal(state.board[sq('e5')], null);
  assert.equal(state.board.filter(Boolean).length, 30);
  // Taking on f7 blows up the king next to it, with the bishop and the knight;
  // the pawn beside it and the queen two files away are untouched.
  state = playAll(state, 'a7a6 b1c3 a6a5 c3e4 a5a4 e4g5 a4a3 g5f7');
  assert.deepEqual(status(state), { over: true, reason: 'explosion', winner: 0, check: false });
  assert.deepEqual(['d8', 'e8', 'f8', 'g8', 'f7', 'g7'].map((n) => state.board[sq(n)]?.type ?? '-'),
    ['q', '-', '-', '-', '-', 'p']);
  assert.deepEqual(legalMoves(state), []);

  // Kings that touch are not in check, and a king never captures.
  const touching = fromFEN('r7/8/8/8/8/8/1k6/K7 w - - 0 1', atomic);
  assert.equal(inCheck(touching, 0), false);
  assert.ok(legalMoves(touching).every((m) => m.capture === undefined));
  assert.equal(inCheck(fromFEN('r7/8/8/8/8/1k6/8/K7 w - - 0 1', atomic), 0), true);
  // A capture that would blow up your own king is not allowed.
  const own = fromFEN('7k/8/8/8/8/8/1p6/KR6 w - - 0 1', atomic);
  assert.equal(findMove(own, { from: sq('b1'), to: sq('b2') }), null);
});

test('horde: pawns against an army', () => {
  const state = createGame(horde);
  assert.equal(state.board.filter((p) => p && p.seat === 0).length, 36);
  assert.equal(status(state).over, false);
  // From the first rank a pawn may go two squares, but not be taken in passing.
  const lone = fromFEN('k7/8/8/8/8/8/8/P7 w - - 0 1', horde);
  const jumped = applyMove(lone, { from: sq('a1'), to: sq('a3') });
  assert.equal(jumped.ep, null);
  assert.ok(applyMove(lone, { from: sq('a1'), to: sq('a2') }));
  assert.ok(applyMove(fromFEN('k7/8/8/8/8/8/P7/8 w - - 0 1', horde), { from: sq('a2'), to: sq('a4') }).ep);
  assert.deepEqual(status(fromFEN('4k3/8/8/8/8/8/8/8 w - - 0 1', horde)),
    { over: true, reason: 'horde', winner: 1, check: false });
  assert.equal(status(fromFEN('k7/P7/1P6/8/8/8/8/8 b - - 0 1', horde)).over, false);
  assert.equal(status(fromFEN('k7/1PP5/PP6/8/8/8/8/8 b - - 0 1', horde)).reason, 'checkmate');
});

test('racing kings: first to the last rank, with one move to draw level', () => {
  const start = createGame(racingKings);
  assert.equal(inCheck(start, 0) || inCheck(start, 1), false);
  // No move may give check: the knight on e2 cannot go to c3, next to nothing
  // but checking the king on a2.
  assert.equal(findMove(start, { from: sq('e2'), to: sq('c3') }), null);

  const race = fromFEN('8/k5K1/8/8/8/8/8/8 w - - 0 1', racingKings);
  const ahead = applyMove(race, { from: sq('g7'), to: sq('g8') });
  assert.equal(status(ahead).over, false);
  assert.deepEqual(status(applyMove(ahead, { from: sq('a7'), to: sq('a8') })),
    { over: true, reason: 'goal', winner: null, check: false });
  assert.equal(status(applyMove(ahead, { from: sq('a7'), to: sq('a6') })).winner, 0);
  // Too far behind to follow: the race is over at once.
  const far = fromFEN('8/6K1/8/8/8/8/k7/8 w - - 0 1', racingKings);
  assert.equal(status(applyMove(far, { from: sq('g7'), to: sq('h8') })).winner, 0);
  // Black arriving first wins without White getting another move.
  const black = fromFEN('8/k7/8/8/8/8/6K1/8 b - - 0 1', racingKings);
  assert.equal(status(applyMove(black, { from: sq('a7'), to: sq('b8') })).winner, 1);
});

test('crazyhouse: captured pieces come back', () => {
  let state = playAll(createGame(crazyhouse), 'e2e4 d7d5 e4d5 d8d5');
  assert.deepEqual(state.pockets, [{ p: 1 }, { p: 1 }]);
  const drops = legalDrops(state, 'p');
  assert.ok(drops.length > 0 && drops.every((m) => m.to >= 8 && m.to < 56));
  assert.deepEqual(legalDrops(state, 'n'), []);
  const drop = findMove(state, { drop: 'p', to: sq('e4') });
  assert.equal(toSan(state, drop), 'P@e4');
  state = applyMove(state, drop);
  assert.deepEqual([state.board[sq('e4')].type, state.pockets[0].p], ['p', 0]);
  assert.equal(findMove(state, { drop: 'q', to: sq('e5') }), null);
  // A pawn dropped on its second rank may still go two squares.
  const second = fromFEN('4k3/8/8/8/8/8/8/4K3 w - - 0 1', crazyhouse);
  second.pockets = [{ p: 1 }, {}];
  const dropped = applyMove(applyMove(second, { drop: 'p', to: sq('a2') }), { from: sq('e8'), to: sq('e7') });
  assert.ok(findMove(dropped, { from: sq('a2'), to: sq('a4') }));

  // A promoted piece goes into the pocket as the pawn it was.
  let promo = fromFEN('1r2k3/P7/8/8/8/8/8/4K3 w - - 0 1', crazyhouse);
  promo = playAll(promo, 'a7a8q b8a8');
  assert.deepEqual(promo.pockets[1], { p: 1 });

  // A drop can answer a check that nothing else can.
  const mated = fromFEN('7k/8/8/8/8/8/PP6/K6r w - - 0 1', crazyhouse);
  assert.equal(status(mated).reason, 'checkmate');
  mated.pockets = [{ n: 1 }, {}];
  assert.equal(status(mated).over, false);
  assert.ok(legalMoves(mated).every((m) => m.drop === 'n'));
});

test('who can still win when the other side runs out of time', () => {
  const bare = '8/8/4k3/8/8/3K4/8/8 w - - 0 1';
  assert.equal(canWinOnTime(fromFEN(bare, standard), 0), false);
  assert.equal(canWinOnTime(fromFEN('8/8/4k3/8/8/3KP3/8/8 w - - 0 1', standard), 0), true);
  assert.equal(canWinOnTime(fromFEN(bare, racingKings), 0), true);
});

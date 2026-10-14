// The rules of Mill: the three boards, putting down, moving and flying,
// mills and what they may take, and how a game ends.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VARIANTS, createGame, tryMove, applyMove, legalMoves, status, moveName, removable, positionKey, EMPTY, QUIET_LIMIT,
} from '../shared/rules.js';

const { nine, six, twelve } = VARIANTS;
const at = (v, name) => v.points.findIndex((p) => p.name === name);
const names = (v, points) => points.map((p) => v.points[p].name).sort();

// A position of `v` with seat 0's pieces on `w` and seat 1's on `b`, the
// given pieces still in hand, and `turn` to move.
function position(v, { w = [], b = [], inHand = [0, 0], turn = 0 }) {
  const state = createGame(v);
  for (const n of w) state.board[at(v, n)] = 0;
  for (const n of b) state.board[at(v, n)] = 1;
  state.inHand = inHand;
  state.onBoard = [w.length, b.length];
  state.turn = turn;
  state.seen = [positionKey(state)];
  return state;
}

test('the boards', () => {
  assert.deepEqual([nine.points.length, nine.mills.length, nine.pieces], [24, 16, 9]);
  assert.deepEqual([six.points.length, six.mills.length, six.pieces], [16, 8, 6]);
  assert.deepEqual([twelve.points.length, twelve.mills.length, twelve.pieces], [24, 20, 12]);
  assert.deepEqual(names(nine, nine.neighbours[at(nine, 'd2')]), ['b2', 'd1', 'd3', 'f2']);
  assert.deepEqual(names(nine, nine.neighbours[at(nine, 'a1')]), ['a4', 'd1']);
  assert.deepEqual(names(twelve, twelve.neighbours[at(twelve, 'b2')]), ['a1', 'b4', 'c3', 'd2']);
  // Six Men's squares are joined, but those joins are no mills.
  assert.deepEqual(names(six, six.neighbours[at(six, 'c1')]), ['a1', 'c2', 'e1']);
  assert.ok(!six.mills.some((m) => m.includes(at(six, 'c1')) && m.includes(at(six, 'c2'))));
});

test('putting pieces down, then moving them along the lines', () => {
  let state = createGame(nine);
  assert.match(tryMove(state, nine, { from: 0, to: 1 }).error, /Put down/);
  state = applyMove(state, nine, { to: at(nine, 'd1') });
  assert.deepEqual([state.turn, state.inHand, state.onBoard], [1, [8, 9], [1, 0]]);
  assert.match(tryMove(state, nine, { to: at(nine, 'd1') }).error, /free point/);
  assert.equal(legalMoves(state, nine).length, 23);

  const moving = position(nine, { w: ['d2', 'a1', 'g7', 'b6'], b: ['d3', 'g1', 'a7', 'f4'] });
  assert.match(tryMove(moving, nine, { to: at(nine, 'b2') }).error, /own pieces/);
  assert.match(tryMove(moving, nine, { from: at(nine, 'd3'), to: at(nine, 'e3') }).error, /own pieces/);
  assert.match(tryMove(moving, nine, { from: at(nine, 'a1'), to: at(nine, 'b2') }).error, /along a line/);
  assert.equal(tryMove(moving, nine, { from: at(nine, 'a1'), to: at(nine, 'a4') }).error, undefined);
});

test('three pieces fly; Twelve Men\'s moves along diagonals', () => {
  const three = position(nine, { w: ['a1', 'g7', 'd5'], b: ['d1', 'g1', 'a7', 'f4'] });
  assert.equal(tryMove(three, nine, { from: at(nine, 'a1'), to: at(nine, 'e4') }).error, undefined);
  const twelveBoard = position(twelve, { w: ['a1', 'g7', 'd5', 'd6'], b: ['d1', 'g1', 'a7', 'f4'] });
  assert.equal(tryMove(twelveBoard, twelve, { from: at(twelve, 'a1'), to: at(twelve, 'b2') }).error, undefined);
});

test('a mill takes a piece, preferably one not in a mill', () => {
  // White closes a1-d1-g1 by putting a piece on g1. Black's a7-d7-g7 is a
  // mill, so b2 must go.
  const state = position(nine, { w: ['a1', 'd1'], b: ['a7', 'd7', 'g7', 'b2'], inHand: [3, 3] });
  assert.match(tryMove(state, nine, { to: at(nine, 'g1') }).error, /Take one/);
  assert.match(tryMove(state, nine, { to: at(nine, 'g1'), remove: at(nine, 'd7') }).error, /Take one/);
  assert.match(tryMove(state, nine, { to: at(nine, 'a4'), remove: at(nine, 'b2') }).error, /Only a mill/);
  const after = applyMove(state, nine, { to: at(nine, 'g1'), remove: at(nine, 'b2') });
  assert.deepEqual([after.board[at(nine, 'b2')], after.onBoard, after.quiet], [EMPTY, [3, 3], 0]);
  // With every piece in a mill, any of them may go.
  const allInMills = position(nine, { w: ['a1', 'd1'], b: ['a7', 'd7', 'g7'], inHand: [3, 3] });
  assert.deepEqual(names(nine, removable(allInMills.board, nine, 1)), ['a7', 'd7', 'g7']);
  assert.equal(legalMoves(allInMills, nine).filter((m) => m.to === at(nine, 'g1')).length, 3);
  assert.equal(moveName(nine, { from: at(nine, 'd2'), to: at(nine, 'd3'), remove: at(nine, 'g7') }), 'd2-d3xg7');
  assert.equal(moveName(nine, { to: at(nine, 'd2') }), 'd2');
});

test('losing by pieces or by being blocked', () => {
  const two = position(nine, { w: ['a1', 'd1', 'g7'], b: ['b4', 'f4'], turn: 1 });
  assert.deepEqual(status(two, nine), { over: true, reason: 'pieces', winner: 0 });
  // Pieces in hand still count.
  assert.equal(status(position(nine, { w: ['a1'], b: ['b4'], inHand: [5, 5], turn: 1 }), nine).over, false);
  // Each of Black's four pieces is boxed in by White's.
  const blocked = position(nine, { w: ['d1', 'a4', 'g4', 'd3', 'c4', 'e4'], b: ['a1', 'g1', 'c3', 'e3'], turn: 1 });
  assert.deepEqual(status(blocked, nine), { over: true, reason: 'blocked', winner: 0 });
});

test('draws: a full board, repetition and fifty quiet moves each', () => {
  const full = createGame(twelve);
  full.board = full.board.map((_, p) => p % 2);
  full.inHand = [0, 0];
  full.onBoard = [12, 12];
  assert.deepEqual(status(full, twelve), { over: true, reason: 'full', winner: null });

  // Two pieces each shuffling back and forth.
  let state = position(nine, { w: ['a1', 'd2', 'g7', 'f4'], b: ['g1', 'd6', 'a7', 'b4'] });
  const moves = [['a1', 'a4'], ['g1', 'g4'], ['a4', 'a1'], ['g4', 'g1']];
  for (let round = 0; round < 2; round++) {
    for (const [from, to] of moves) {
      assert.equal(status(state, nine).over, false);
      state = applyMove(state, nine, { from: at(nine, from), to: at(nine, to) });
    }
  }
  assert.deepEqual(status(state, nine), { over: true, reason: 'repetition', winner: null });

  const quiet = position(nine, { w: ['a1', 'd2', 'g7', 'f4'], b: ['g1', 'd6', 'a7', 'b4'] });
  quiet.quiet = QUIET_LIMIT;
  assert.deepEqual(status(quiet, nine), { over: true, reason: 'quiet', winner: null });
});

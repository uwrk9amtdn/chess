// The rules of Gomoku: rows of five in each variant, and Renju's forbidden
// moves for Black.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, tryMove, applyMove, forbiddenReason, forbiddenPoints, pointName, starPoints, isFull, BLACK, WHITE, EMPTY,
} from '../shared/rules.js';

const at = (size, name) => 'ABCDEFGHIJKLMNOPQRS'.indexOf(name[0]) + (Number(name.slice(1)) - 1) * size;

// A 15x15 position with the given stones, and `turn` to play.
function position({ x = [], o = [] }, turn = BLACK, size = 15) {
  const state = createGame(size);
  for (const name of x) state.board[at(size, name)] = BLACK;
  for (const name of o) state.board[at(size, name)] = WHITE;
  state.turn = turn;
  state.count = x.length + o.length;
  return state;
}

const reason = (stones, point) => forbiddenReason(position(stones).board, 15, at(15, point));

test('names and star points', () => {
  assert.equal(pointName(15, 0), 'A1');
  assert.equal(pointName(15, at(15, 'H8')), 'H8');
  assert.equal(pointName(15, at(15, 'I9')), 'I9');
  assert.deepEqual(starPoints(15).map((p) => pointName(15, p)).sort(), ['D12', 'D4', 'H8', 'L12', 'L4']);
  assert.equal(starPoints(19).length, 9);
});

test('moves alternate and five wins', () => {
  let state = createGame(15);
  assert.match(tryMove(state, 225, 'freestyle').error, /board/);
  state = applyMove(state, at(15, 'H8'), 'freestyle');
  assert.deepEqual([state.turn, state.count, state.board[at(15, 'H8')]], [WHITE, 1, BLACK]);
  assert.match(tryMove(state, at(15, 'H8'), 'freestyle').error, /taken/);

  const four = position({ x: ['D8', 'E8', 'F8', 'G8'], o: ['D9', 'E9', 'F9', 'G9'] });
  const { line } = tryMove(four, at(15, 'H8'), 'freestyle');
  assert.deepEqual(line.map((p) => pointName(15, p)), ['D8', 'E8', 'F8', 'G8', 'H8']);
  assert.equal(tryMove(four, at(15, 'A1'), 'freestyle').line, null);
  // A diagonal counts too.
  const diagonal = position({ x: ['A1', 'B2', 'C3', 'D4'] });
  assert.equal(tryMove(diagonal, at(15, 'E5'), 'standard').line.length, 5);
});

test('six in a row: Freestyle wins, Standard does not, Renju only for White', () => {
  const black = position({ x: ['C8', 'D8', 'E8', 'G8', 'H8'] });
  assert.equal(tryMove(black, at(15, 'F8'), 'freestyle').line.length, 6);
  assert.equal(tryMove(black, at(15, 'F8'), 'standard').line, null);
  assert.match(tryMove(black, at(15, 'F8'), 'renju').error, /overline/);
  const white = position({ o: ['C8', 'D8', 'E8', 'G8', 'H8'] }, WHITE);
  assert.equal(tryMove(white, at(15, 'F8'), 'renju').line.length, 6);
  assert.equal(tryMove(white, at(15, 'F8'), 'standard').line, null);
});

test('Renju: double three, double four and what is still allowed', () => {
  // Two open threes through H8.
  assert.equal(reason({ x: ['G8', 'I8', 'H7', 'H9'] }, 'H8'), 'double three');
  // A four on one line and a three on another (four-three) is allowed.
  assert.equal(reason({ x: ['G8', 'I8', 'J8', 'H7', 'H9'] }, 'H8'), null);
  // A three blocked at one end can never be a straight four.
  assert.equal(reason({ x: ['G8', 'I8', 'H7', 'H9'], o: ['F8'] }, 'H8'), null);
  // Two fours, on two lines or on one.
  assert.equal(reason({ x: ['F8', 'G8', 'I8', 'H5', 'H6', 'H7'] }, 'H8'), 'double four');
  assert.equal(reason({ x: ['C8', 'D8', 'E8', 'I8', 'J8', 'K8'] }, 'G8'), 'double four');
  // Five always may be made, whatever else it makes.
  assert.equal(reason({ x: ['D8', 'E8', 'F8', 'G8', 'H5', 'H6', 'H7'] }, 'H8'), null);
  assert.equal(reason({ x: ['E8', 'F8', 'G8', 'I8', 'J8'] }, 'H8'), 'overline');
  // One three, or one four, is fine.
  assert.equal(reason({ x: ['G8', 'I8'] }, 'H8'), null);
  assert.equal(reason({ x: ['F8', 'G8', 'I8'] }, 'H8'), null);
  assert.equal(reason({ x: ['G8', 'I8'] }, 'A1'), null);
});

test('Renju: forbidden points only bind Black', () => {
  const stones = { x: ['G8', 'I8', 'H7', 'H9'], o: ['A1', 'A2', 'A3', 'A4'] };
  assert.match(tryMove(position(stones), at(15, 'H8'), 'renju').error, /double three/);
  assert.equal(tryMove(position(stones), at(15, 'H8'), 'freestyle').error, undefined);
  assert.deepEqual(forbiddenPoints(position(stones), 'renju').map((p) => pointName(15, p)), ['H8']);
  assert.deepEqual(forbiddenPoints(position(stones, WHITE), 'renju'), []);
  // The same shape is fine for White.
  const white = position({ o: ['G8', 'I8', 'H7', 'H9'], x: ['A1'] }, WHITE);
  assert.equal(tryMove(white, at(15, 'H8'), 'renju').error, undefined);
});

test('a full board', () => {
  const state = createGame(15);
  state.count = 225;
  assert.ok(isFull(state));
  assert.ok(!isFull(createGame(15)));
});

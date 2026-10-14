// The bot's search: it closes a mill when it can, stops one it must, and
// finishes a won game.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VARIANTS, createGame, positionKey, moveName } from '../shared/rules.js';
import { chooseMove, search, evaluate, levelSettings, BOT_LEVELS } from '../shared/search.js';

const { nine, six } = VARIANTS;
const at = (v, name) => v.points.findIndex((p) => p.name === name);

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

const best = (state, v, level) => moveName(v, chooseMove(state, v, level, { random: () => 0.5 }).move);

test('every level wins a piece it is offered, and the stronger ones stop the other side\'s mill', () => {
  // White can put its third piece on g1 and take a black one, or first
  // add a second threat Black cannot also stop; either wins a piece.
  const close = position(nine, { w: ['a1', 'd1'], b: ['d2', 'f4'], inHand: [7, 7] });
  for (let level = 1; level <= BOT_LEVELS; level++) {
    const { move, score } = chooseMove(close, nine, level, { random: () => 0.5 });
    assert.ok(move.remove !== undefined || score >= 90, `level ${level}: ${moveName(nine, move)} ${score}`);
  }
  // Black threatens a7-d7-g7; White has nothing better than to block it.
  const block = position(nine, { w: ['d2'], b: ['a7', 'd7'], inHand: [8, 7] });
  for (const level of [4, 6, 8]) assert.equal(best(block, nine, level), 'g7', `level ${level}`);
});

test('a won ending is played out', () => {
  // White flies to close a mill and leaves Black with two pieces.
  const state = position(nine, { w: ['a1', 'd1', 'g7'], b: ['b4', 'f4', 'd5'], turn: 0 });
  const found = search(state, nine, levelSettings(5));
  assert.equal(moveName(nine, found.move).slice(0, 6), 'g7-g1x');
  assert.ok(found.score > 100_000);
  assert.ok(evaluate(position(six, { w: ['a1', 'c1', 'e1'], b: ['a5'], inHand: [3, 5] }), six) > 0);
  assert.equal(chooseMove(createGame(six), six, 1, { random: () => 0 }).move.from, undefined);
});

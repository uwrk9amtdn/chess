// The bot's search: it takes a five, stops the opponent's, sees threats a
// move ahead, keeps to Renju's rules, and plays the Swap2 opening.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, pointName, forbiddenReason, BLACK, WHITE, EMPTY } from '../shared/rules.js';
import { search, chooseMove, levelSettings, openingStones, chooseColour, BOT_LEVELS } from '../shared/search.js';

const at = (name) => 'ABCDEFGHIJKLMNO'.indexOf(name[0]) + (Number(name.slice(1)) - 1) * 15;

function position({ x = [], o = [] }, turn = BLACK) {
  const state = createGame(15);
  for (const name of x) state.board[at(name)] = BLACK;
  for (const name of o) state.board[at(name)] = WHITE;
  state.turn = turn;
  state.count = x.length + o.length;
  return state;
}

const best = (state, variant, level) => pointName(15, chooseMove(state, variant, level, { random: () => 0.5 }).point);

test('the first stone goes in the centre', () => {
  assert.equal(best(createGame(15), 'freestyle', 1), 'H8');
});

test('every level makes five and stops the opponent\'s', () => {
  const win = position({ x: ['D8', 'E8', 'F8', 'G8'], o: ['D9', 'E9', 'F9', 'G9'] });
  const block = position({ x: ['D8', 'E8', 'F8', 'A1'], o: ['D9', 'E9', 'F9', 'G9'] });
  for (let level = 1; level <= BOT_LEVELS; level++) {
    assert.match(best(win, 'freestyle', level), /^[CH]8$/, `level ${level}`);
    assert.match(best(block, 'freestyle', level), /^[CH]9$/, `level ${level}`);
  }
});

test('the stronger levels stop an open three and find a winning four-three', () => {
  // White's open three on row 9 must be stopped at one end.
  const three = position({ x: ['H8', 'A1'], o: ['F9', 'G9', 'H9'] });
  assert.match(best(three, 'freestyle', 5), /^(E9|I9|D9|J9)$/);
  // Black wins with H8: a four along row 8 and an open three up the H line.
  const fourThree = position({ x: ['E8', 'F8', 'G8', 'H6', 'H7'], o: ['D8', 'A1', 'A3', 'C1', 'O15'] });
  const found = search(fourThree, 'freestyle', levelSettings(6));
  assert.equal(pointName(15, found.point), 'H8');
  assert.ok(found.score > 1_000_000);
});

test('in Renju the bot never plays Black onto a forbidden point', () => {
  // H8 is Black's best-looking point but a double three, so the bot must
  // look elsewhere; in Freestyle it takes it.
  const state = position({ x: ['G8', 'I8', 'H7', 'H9'], o: ['A1', 'A3', 'O15', 'O13'] });
  for (const level of [1, 5, 8]) {
    const point = chooseMove(state, 'renju', level, { random: () => 0.5 }).point;
    assert.equal(forbiddenReason(state.board.slice(), 15, point), null, `level ${level}`);
  }
  assert.equal(best(state, 'freestyle', 5), 'H8');
});

test('Swap2: three opening stones near the centre, and a colour', () => {
  const stones = openingStones(15, () => 0.3);
  assert.equal(new Set(stones).size, 3);
  for (const p of stones) assert.ok(Math.abs((p % 15) - 7) <= 2 && Math.abs(Math.floor(p / 15) - 7) <= 2);
  const state = position({ x: ['H8', 'I9'], o: ['H9'] }, WHITE);
  assert.ok([BLACK, WHITE].includes(chooseColour(state, 'freestyle')));
  assert.equal(state.board.filter((c) => c !== EMPTY).length, 3);
});

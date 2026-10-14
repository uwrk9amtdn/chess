// The rules of Go, the clocks and the bot's search.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, tryMove, applyMove, score, handicapPoints, starPoints, pointName, moveName, boardKey,
  BLACK, WHITE, EMPTY, KOMI,
} from '../shared/rules.js';
import { initialClock, spend, afterMove } from '../shared/clock.js';
import { guessDead } from '../shared/playout.js';
import { search, levelSettings, BOT_LEVELS } from '../shared/mcts.js';

// A position from rows of 'x' (Black), 'o' (White) and '.', top row first.
function position(rows, turn = BLACK) {
  const size = rows.length;
  const state = createGame(size);
  state.board = rows.slice().reverse().join('').split('').map((c) => ({ x: BLACK, o: WHITE }[c] ?? EMPTY));
  state.turn = turn;
  state.seen = [boardKey(state.board)];
  return state;
}

const at = (size, name) => {
  const x = 'ABCDEFGHJKLMNOPQRST'.indexOf(name[0]);
  return (Number(name.slice(1)) - 1) * size + x;
};

test('names of points and moves', () => {
  assert.equal(pointName(19, 0), 'A1');
  assert.equal(pointName(19, 18), 'T1');
  assert.equal(pointName(19, 3 * 19 + 3), 'D4');
  assert.equal(pointName(9, 80), 'J9');
  assert.equal(moveName(9, { pass: true }), 'Pass');
});

test('star points and handicap stones', () => {
  assert.deepEqual(starPoints(9).map((p) => pointName(9, p)).sort(), ['C3', 'C7', 'E5', 'G3', 'G7']);
  assert.equal(starPoints(19).length, 9);
  const names = (n) => handicapPoints(19, n).map((p) => pointName(19, p));
  assert.deepEqual(names(2), ['Q16', 'D4']);
  assert.deepEqual(names(3), ['Q16', 'D4', 'Q4']);
  assert.deepEqual(names(5), ['Q16', 'D4', 'Q4', 'D16', 'K10']);
  assert.deepEqual(names(6), ['Q16', 'D4', 'Q4', 'D16', 'D10', 'Q10']);
  assert.equal(new Set(handicapPoints(19, 9)).size, 9);
  assert.ok(handicapPoints(19, 9).includes(at(19, 'K10')));
  const game = createGame(13, 4);
  assert.equal(game.turn, WHITE);
  assert.equal(game.board.filter((c) => c === BLACK).length, 4);
  assert.equal(createGame(9).turn, BLACK);
});

test('captures, suicide and the occupied point', () => {
  const state = position([
    '.....',
    '..x..',
    '.xo..',
    '..x..',
    '.....',
  ]);
  const { state: after } = tryMove(state, { point: at(5, 'D3') });
  assert.equal(after.board[at(5, 'C3')], EMPTY);
  assert.deepEqual(after.captures, [1, 0]);
  assert.equal(after.turn, WHITE);
  // White may not play into the hole it would have no liberties in.
  assert.match(tryMove(after, { point: at(5, 'C3') }).error, /Suicide/);
  assert.match(tryMove(after, { point: at(5, 'B3') }).error, /taken/);
  assert.match(tryMove(after, { point: 99 }).error, /board/);
  // Unless it takes something with it.
  const corner = position([
    '.xo..',
    'xo...',
    '.....',
    '.....',
    '.....',
  ], WHITE);
  const taking = tryMove(corner, { point: at(5, 'A5') }).state;
  assert.deepEqual([taking.board[at(5, 'B5')], taking.captures], [EMPTY, [0, 1]]);
});

test('ko and superko', () => {
  const state = position([
    '.....',
    '.xo..',
    'x.xo.',
    '.xo..',
    '.....',
  ], WHITE);
  // White takes at B3, then Black may not take straight back at C3.
  const taken = applyMove(state, { point: at(5, 'B3') });
  assert.equal(taken.board[at(5, 'C3')], EMPTY);
  assert.match(tryMove(taken, { point: at(5, 'C3') }).error, /Ko/);
  // After moves elsewhere it may.
  const later = applyMove(applyMove(taken, { point: at(5, 'E1') }), { point: at(5, 'E5') });
  assert.equal(tryMove(later, { point: at(5, 'C3') }).error, undefined);
  // Passing changes nothing on the board but whose turn it is.
  const passed = applyMove(later, { pass: true });
  assert.deepEqual([passed.turn, passed.passes, passed.board], [WHITE, 1, later.board]);
  assert.equal(applyMove(passed, { point: 0 }).passes, 0);
});

test('area scoring with dead stones', () => {
  const state = position([
    '..xo.',
    '..xo.',
    '.oxo.',
    '..xo.',
    '..xo.',
  ]);
  const alive = score(state, [], 0.5);
  // The white stone on B3 makes Black's side shared, so nobody owns it.
  assert.deepEqual([alive.black, alive.white], [5, 11.5]);
  const counted = score(state, [at(5, 'B3')], 0.5);
  assert.deepEqual([counted.black, counted.white, counted.winner], [15, 10.5, BLACK]);
  assert.equal(counted.owner[at(5, 'B3')], BLACK);
  assert.equal(score(createGame(9), [], KOMI).winner, WHITE);
});

test('guessing dead stones', () => {
  // The lone white stone in Black's area is dead; the walls are alive.
  const state = position([
    '...x.o...',
    '...x.o...',
    '.o.x.o...',
    '...x.o...',
    '...x.o...',
    '...x.o...',
    '...x.o...',
    '...x.o...',
    '...x.o...',
  ]);
  assert.deepEqual(guessDead(state), [at(9, 'B7')]);
  assert.deepEqual(guessDead(createGame(9)), []);
});

test('clocks: Fischer and byo-yomi', () => {
  const fischer = { clock: 'fischer', minutes: 1, increment: 2 };
  assert.deepEqual(initialClock(fischer), { ms: 60_000, periods: 0, byo: false });
  assert.deepEqual(afterMove(initialClock(fischer), 10_000, fischer), { ms: 52_000, periods: 0, byo: false });
  assert.equal(afterMove(initialClock(fischer), 60_000, fischer), null);

  const byoyomi = { clock: 'byoyomi', minutes: 1, periods: 3, period: 10 };
  const start = initialClock(byoyomi);
  assert.deepEqual(start, { ms: 60_000, periods: 3, byo: false });
  // Into the first period, then a move within it keeps all three.
  assert.deepEqual(spend(start, 65_000, 10_000), { ms: 5_000, periods: 2, byo: true });
  assert.deepEqual(afterMove(start, 65_000, byoyomi), { ms: 10_000, periods: 2, byo: true });
  // Running past one period uses it up.
  assert.deepEqual(afterMove(start, 75_000, byoyomi), { ms: 10_000, periods: 1, byo: true });
  assert.equal(afterMove(start, 90_000, byoyomi), null);
  assert.deepEqual(initialClock({ ...byoyomi, minutes: 0 }), { ms: 10_000, periods: 2, byo: true });
});

test('the bot plays legal moves and passes once nothing is left', () => {
  const opening = search(createGame(9), { komi: KOMI, playouts: 300, timeMs: 5000, random: () => 0.5 });
  assert.ok(Number.isInteger(opening.move.point) && opening.move.point >= 0 && opening.move.point < 81);
  assert.ok(opening.winrate > 0 && opening.winrate < 1);

  // Every empty point is an eye of one side, so there is nothing to play.
  const settled = position([
    'x.xxo.o.o',
    'xxxxooooo',
    'xx.xo.oo.',
    'xxxxooooo',
    '.xxxoo.oo',
    'xxxxooooo',
    'xx.xo.o.o',
    'xxxxooooo',
    'x.xxoo.oo',
  ]);
  assert.deepEqual(search(settled, { komi: KOMI, playouts: 300, timeMs: 5000 }).move, { pass: true });
  // White leads, and passes once Black has.
  const ahead = { ...settled, turn: WHITE, passes: 1 };
  assert.deepEqual(search(ahead, { komi: KOMI, playouts: 300, timeMs: 5000 }).move, { pass: true });
  for (let level = 1; level <= BOT_LEVELS; level++) assert.ok(levelSettings(level).playouts > 0);
});

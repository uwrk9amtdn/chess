// The bot's own search: that it sees what is in front of it, and that it can
// play every variant to the end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyLegal, findMove, status, fromFEN, toSan, teamOf, seatToMove } from '../shared/engine.js';
import { variants, BOT_LEVELS } from '../shared/variants.js';
import { search, evaluate, levelSettings } from '../shared/search.js';

const best = (fen, variant, options) => {
  const state = fromFEN(fen, variant);
  return toSan(state, search(state, options).move);
};

test('mate, material and the levels', () => {
  const { standard } = variants;
  assert.equal(best('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', standard, { depth: 1 }), 'Ra8#');
  // Mate in two: the rook lift cuts the king off before the other mates.
  assert.match(best('7k/8/8/8/8/8/R7/1R4K1 w - - 0 1', standard, { depth: 3 }), /^R[ab]g2|^Ra7|^Rb7/);
  assert.equal(best('4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1', standard, { depth: 2 }), 'Rxd5');
  // A defended pawn is not worth a queen.
  assert.notEqual(best('4k3/2p5/3p4/8/8/8/3Q4/4K3 w - - 0 1', standard, { depth: 1 }), 'Qxd6');
  // The weakest level still takes a mate in one, whatever it rolls.
  for (const random of [() => 0, () => 0.5, () => 0.999]) {
    assert.equal(best('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', standard, { ...levelSettings(1), random }), 'Ra8#');
  }
  assert.equal(search(fromFEN('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', standard)), null);
  assert.equal(evaluate(createGame(standard), 0), 0);
  for (let level = 1; level <= BOT_LEVELS; level++) assert.ok(levelSettings(level).depth >= 1);
});

test('what the variants are about', () => {
  // Giving a piece away, walking up the hill, the third check, a king to blow up.
  assert.equal(best('8/8/8/8/8/1p6/8/R7 w - - 0 1', variants.antichess, { depth: 2 }), 'Ra2');
  assert.match(best('7k/8/8/8/8/4K3/8/8 w - - 0 1', variants.kingOfTheHill, { depth: 1 }), /^K[de]4$/);
  const checked = fromFEN('4k3/8/8/8/8/8/8/R3K3 w - - 0 1', variants.threeCheck);
  checked.checks = [2, 0];
  assert.match(toSan(checked, search(checked, { depth: 1 }).move), /\+$/);
  assert.equal(best('3qk3/8/8/8/8/8/8/3QK3 w - - 0 1', variants.atomic, { depth: 1 }), 'Qxd8');
});

test('a game of every variant, played to the end', () => {
  for (const variant of Object.values(variants)) {
    let state = createGame(variant, variant.starts ? 0 : undefined);
    // Looking one move ahead keeps this quick; the 16x16 board only gets an
    // opening. Random enough for the games to differ, the same on every run.
    let seed = 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const big = variant.width > 8;
    for (let ply = 0; ply < (big ? 12 : 300) && !status(state).over; ply++) {
      const startedAt = Date.now();
      const found = search(state, { depth: 1, noise: 150, random });
      assert.ok(Date.now() - startedAt < 5000, `${variant.id} took too long`);
      assert.ok(findMove(state, found.move), `${variant.id}: not a legal move`);
      assert.ok(Number.isFinite(found.score) && Number.isFinite(evaluate(state, teamOf(variant, seatToMove(state)))));
      state = applyLegal(state, found.move);
    }
    assert.ok(big || status(state).over, `${variant.id} did not end`);
  }
});

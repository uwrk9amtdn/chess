// Go on the server: the invitation options, a match on its own, and one game
// through the real lobby.

import test from 'node:test';
import assert from 'node:assert/strict';
import go from '../server/index.js';
import { createGame, applyMove, boardKey } from '../shared/rules.js';
import { startServer } from '../../../server/index.js';
import { connect } from '../../../test/helpers.js';

const FISCHER = { size: 9, handicap: 0, clock: 'fischer', minutes: 5, increment: 3 };

test('invitation options', () => {
  assert.deepEqual(go.validateOptions({ clock: 'fischer', minutes: 5, increment: 3, junk: 1 }).options,
    { size: 19, handicap: 0, clock: 'fischer', minutes: 5, increment: 3 });
  assert.deepEqual(go.validateOptions({ size: 13, handicap: 4, clock: 'byoyomi', minutes: 0, periods: 5, period: 30 }).options,
    { size: 13, handicap: 4, clock: 'byoyomi', minutes: 0, periods: 5, period: 30 });
  for (const bad of [
    {}, { ...FISCHER, size: 10 }, { ...FISCHER, handicap: 1 }, { ...FISCHER, handicap: 10 }, { ...FISCHER, minutes: 0 },
    { ...FISCHER, increment: 1.5 }, { ...FISCHER, minutes: '5' }, { ...FISCHER, clock: 'hourglass' },
    { size: 9, clock: 'byoyomi', minutes: 5, periods: 0, period: 30 },
    { size: 9, clock: 'byoyomi', minutes: 5, periods: 3, period: 1 },
  ]) {
    assert.ok(go.validateOptions(bad).error, JSON.stringify(bad));
  }
});

test('bots', () => {
  assert.deepEqual(go.validateBot({ level: 5, junk: 1 }, FISCHER), { bot: { level: 5 }, name: 'Computer level 5' });
  for (const bad of [{}, { level: 0 }, { level: 9 }, { level: 2.5 }]) assert.ok(go.validateBot(bad, FISCHER).error);
  const bots = [null, { level: 3 }];
  const match = go.createMatch({ players: ['me', 'Computer level 3'], options: FISCHER, bots, onChange() {} });
  assert.deepEqual(match.snapshot(0).bots, bots);
  match.handle(0, { action: 'resign' });
});

function newMatch(options) {
  const changes = [];
  const match = go.createMatch({
    players: ['black', 'white'],
    options: { ...FISCHER, ...options },
    onChange: (m) => changes.push(m.snapshot(0)),
  });
  return { match, changes };
}

test('moves, captures and the snapshot', () => {
  const { match, changes } = newMatch();
  assert.match(match.handle(1, { action: 'move', point: 40 }), /turn/);
  assert.match(match.handle(0, { action: 'move', point: 81 }), /board/);
  assert.match(match.handle(0, { action: 'move', point: '40' }), /board/);
  assert.match(match.handle(0, { action: 'dance' }), /Unknown/);
  assert.equal(match.handle(0, { action: 'move', point: 40 }), null);
  assert.match(match.handle(1, { action: 'move', point: 40 }), /taken/);
  assert.equal(match.handle(1, { action: 'move', point: 41 }), null);
  const snap = changes.at(-1);
  assert.deepEqual(snap.moves, ['E5', 'F5']);
  assert.deepEqual(snap.played, [{ point: 40 }, { point: 41 }]);
  assert.equal(snap.lastMove, 41);
  assert.equal(snap.running, 0);
  assert.equal(snap.komi, 7.5);
  const replayed = snap.played.reduce(applyMove, createGame(9));
  assert.equal(boardKey(replayed.board), snap.board);
  assert.ok(snap.clocks[0].ms > 300_000 && snap.clocks[0].ms <= 303_000);
  assert.deepEqual(go.preview(match.snapshot(null)), { size: 9, board: snap.board, lastMove: 41 });
  assert.equal(match.snapshot(null).you, null);
  match.handle(1, { action: 'resign' });
  assert.deepEqual(match.over, { reason: 'resign', winner: 0 });
});

test('handicap: White starts and komi is half a point', () => {
  const { match } = newMatch({ size: 19, handicap: 3 });
  const snap = match.snapshot(0);
  assert.deepEqual([snap.turn, snap.komi, [...snap.board].filter((c) => c === 'x').length], [1, 0.5, 3]);
  assert.match(match.handle(0, { action: 'move', point: 0 }), /turn/);
  match.handle(0, { action: 'resign' });
});

test('two passes, marking dead stones, resuming and counting', () => {
  const { match, changes } = newMatch();
  // Black walls off the left; White plays a stone inside it.
  const moves = [[0, 3], [1, 5], [0, 12], [1, 14], [0, 21], [1, 23], [0, 30], [1, 32], [0, 39], [1, 41], [0, 48], [1, 50],
    [0, 57], [1, 59], [0, 66], [1, 68], [0, 75], [1, 77], [0, 4], [1, 10]];
  for (const [seat, point] of moves) assert.equal(match.handle(seat, { action: 'move', point }), null, `${point}`);
  assert.match(match.handle(0, { action: 'toggleDead', point: 10 }), /passed/);
  match.handle(0, { action: 'pass' });
  assert.equal(changes.at(-1).scoring, null);
  assert.equal(changes.at(-1).moves.at(-1), 'Pass');
  match.handle(1, { action: 'pass' });
  let snap = changes.at(-1);
  assert.equal(snap.running, null);
  assert.deepEqual(snap.scoring.dead, [10]);
  assert.match(match.handle(1, { action: 'move', point: 1 }), /stopped/);
  assert.equal(match.handle(1, { action: 'offerTakeback' }), null);
  assert.equal(match.takebackOffer, null);

  // Changing the marking undoes any agreement.
  match.handle(0, { action: 'acceptScore' });
  assert.deepEqual(changes.at(-1).scoring.accepted, [true, false]);
  match.handle(1, { action: 'toggleDead', point: 10 });
  assert.deepEqual(changes.at(-1).scoring, { ...changes.at(-1).scoring, dead: [], accepted: [false, false] });
  assert.match(match.handle(1, { action: 'toggleDead', point: 1 }), /no stone/);

  // White would rather play on; Black passed first, so Black moves.
  match.handle(1, { action: 'resume' });
  snap = changes.at(-1);
  assert.deepEqual([snap.scoring, snap.running, snap.passes], [null, 0, 0]);
  match.handle(0, { action: 'pass' });
  match.handle(1, { action: 'pass' });
  assert.deepEqual(changes.at(-1).scoring.dead, [10]);
  match.handle(0, { action: 'acceptScore' });
  match.handle(1, { action: 'acceptScore' });
  // Black: 10 stones and 27 points behind them. White: 9 stones, 27 points
  // and komi. The column between them is nobody's.
  assert.deepEqual(match.over, { reason: 'score', winner: 1, black: 37, white: 36 + 7.5 });
  assert.deepEqual(changes.at(-1).dead, [10]);
  assert.equal(changes.at(-1).scoring, false);
});

test('leaving the game for good loses it, also while counting', () => {
  const { match, changes } = newMatch();
  match.setConnected(1, false);
  assert.deepEqual(changes.at(-1).connected, [true, false]);
  match.abandon(1);
  assert.deepEqual(match.over, { reason: 'abandoned', winner: 0 });

  const counting = newMatch().match;
  counting.handle(0, { action: 'pass' });
  counting.handle(1, { action: 'pass' });
  counting.abandon(0);
  assert.deepEqual(counting.over, { reason: 'abandoned', winner: 1 });
});

test('takebacks', () => {
  const { match, changes } = newMatch();
  match.handle(0, { action: 'offerTakeback' });
  assert.equal(match.takebackOffer, null);
  match.handle(0, { action: 'move', point: 40 });
  match.handle(1, { action: 'move', point: 41 });
  match.handle(0, { action: 'offerTakeback' });
  match.handle(0, { action: 'acceptTakeback' });
  assert.equal(match.takebackOffer, 0);
  match.handle(1, { action: 'acceptTakeback' });
  const snap = changes.at(-1);
  assert.deepEqual([snap.moves, snap.turn, snap.takebacks, snap.lastMove], [[], 0, 1, null]);
  match.handle(0, { action: 'resign' });
});

test('running out of time loses, in byo-yomi too', async () => {
  const { match } = newMatch({ minutes: 0.002, increment: 0 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(match.over, { reason: 'timeout', winner: 1 });

  const byo = newMatch({ clock: 'byoyomi', minutes: 0, periods: 2, period: 0.05 });
  assert.equal(byo.match.handle(0, { action: 'move', point: 40 }), null);
  await new Promise((resolve) => setTimeout(resolve, 60));
  // White used up a period but still has one, and keeps it by moving.
  assert.equal(byo.match.handle(1, { action: 'move', point: 41 }), null);
  assert.deepEqual(byo.changes.at(-1).clocks[1], { ms: 50, periods: 0, byo: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(byo.match.over, { reason: 'timeout', winner: 1 });
});

test('a 9x9 game through the lobby', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  assert.ok((await alice.next('joined')).games.some((g) => g.id === 'go'));
  await alice.next('users', (m) => m.users.length === 2);

  alice.send({ type: 'invite', to: 'bob', game: 'go', options: { ...FISCHER, size: 8 } });
  await alice.next('error');
  alice.send({ type: 'invite', to: 'bob', game: 'go', options: FISCHER });
  const invite = await bob.next('invite');
  assert.deepEqual(invite.options, FISCHER);
  bob.send({ type: 'accept', id: invite.id });
  const [first] = await Promise.all([alice.next('match'), bob.next('match')]);
  assert.equal(first.game, 'go');
  assert.equal(first.snapshot.board.length, 81);

  const black = first.snapshot.you === 0 ? alice : bob;
  black.send({ type: 'action', action: 'move', point: 40 });
  assert.deepEqual((await black.next('match', (m) => m.snapshot.moves.length === 1)).snapshot.moves, ['E5']);

  const get = async (path) => (await fetch(`http://localhost:${server.port}${path}`)).status;
  assert.equal(await get('/games/go/shared/rules.js'), 200);
  assert.equal(await get('/games/go/server/match.js'), 404);
});

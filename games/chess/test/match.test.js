// Chess on the server: the invitation options, a match on its own, and one
// game through the real lobby.

import test from 'node:test';
import assert from 'node:assert/strict';
import chess from '../server/index.js';
import { startServer } from '../../../server/index.js';
import { connect } from '../../../test/helpers.js';

test('invitation options', () => {
  assert.deepEqual(chess.validateOptions({ minutes: 3, increment: 1 }).options,
    { variant: 'standard', minutes: 3, increment: 1 });
  assert.deepEqual(chess.validateOptions({ minutes: 5, increment: 0, variant: 'double', junk: 1 }).options,
    { variant: 'double', minutes: 5, increment: 0 });
  for (const bad of [
    {}, { minutes: 500, increment: 1 }, { minutes: 0.5, increment: 1 }, { minutes: 3, increment: 1.5 },
    { minutes: 3, increment: 99 }, { minutes: '3', increment: 1 }, { minutes: 3, increment: 1, variant: 'nope' },
    { minutes: 3, increment: 1, variant: 'constructor' },
  ]) {
    assert.ok(chess.validateOptions(bad).error, JSON.stringify(bad));
  }
  assert.ok(chess.validateOptions({ minutes: 0.5, increment: 0 }, { minMinutes: 0.1 }).options);
});

function newMatch(options) {
  const changes = [];
  const match = chess.createMatch({
    players: ['white', 'black'],
    options: { variant: 'standard', minutes: 3, increment: 1, ...options },
    onChange: (m) => changes.push(m.snapshot(0)),
  });
  return { match, changes };
}

test('moves, turn order and the increment', () => {
  const { match, changes } = newMatch();
  assert.match(match.handle(1, { action: 'move', from: 52, to: 36 }), /turn/);
  assert.match(match.handle(0, { action: 'move', from: 12, to: 36 }), /Illegal/);
  assert.match(match.handle(0, { action: 'dance' }), /Unknown/);
  assert.equal(match.handle(0, { action: 'move', from: 12, to: 28 }), null);
  const snap = changes.at(-1);
  assert.deepEqual(snap.moves, ['e4']);
  assert.deepEqual(snap.lastMove, { from: 12, to: 28 });
  assert.equal(snap.running, 1);
  assert.ok(snap.clocks[0] > 180_000 && snap.clocks[0] <= 181_000);
  assert.deepEqual(snap.options, { variant: 'standard', minutes: 3, increment: 1 });
  match.handle(0, { action: 'resign' });
});

test('draw offers and resignation', () => {
  let { match, changes } = newMatch();
  match.handle(0, { action: 'offerDraw' });
  assert.equal(changes.at(-1).drawOffer, 0);
  // The player who offered cannot accept their own offer.
  match.handle(0, { action: 'acceptDraw' });
  assert.equal(match.over, null);
  match.handle(1, { action: 'declineDraw' });
  assert.equal(changes.at(-1).drawOffer, null);
  match.handle(1, { action: 'offerDraw' });
  match.handle(0, { action: 'acceptDraw' });
  assert.deepEqual(match.over, { reason: 'agreement', winner: null });

  ({ match, changes } = newMatch());
  match.handle(1, { action: 'resign' });
  assert.deepEqual(match.over, { reason: 'resign', winner: 0 });
  assert.match(match.handle(0, { action: 'move', from: 12, to: 28 }), /over/);
});

test('running out of time loses', async () => {
  const { match, changes } = newMatch({ minutes: 0.002, increment: 0 });
  match.handle(0, { action: 'move', from: 12, to: 28 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(match.over, { reason: 'timeout', winner: 0 });
  assert.equal(changes.at(-1).clocks[1], 0);
});

test('a 16x16 game through the lobby', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  assert.ok((await alice.next('joined')).games.some((g) => g.id === 'chess'));
  await alice.next('users', (m) => m.users.length === 2);

  alice.send({ type: 'invite', to: 'bob', game: 'chess', options: { minutes: 500, increment: 1 } });
  await alice.next('error');
  alice.send({ type: 'invite', to: 'bob', game: 'chess', options: { minutes: 5, increment: 1, variant: 'double' } });
  const invite = await bob.next('invite');
  assert.deepEqual(invite.options, { variant: 'double', minutes: 5, increment: 1 });
  bob.send({ type: 'accept', id: invite.id });
  const [first] = await Promise.all([alice.next('match'), bob.next('match')]);
  assert.equal(first.game, 'chess');
  assert.equal(first.snapshot.state.board.length, 256);

  // b2-b4 on the wide board: squares are numbered y * 16 + x.
  const white = first.snapshot.you === 0 ? alice : bob;
  white.send({ type: 'action', action: 'move', from: 16 + 1, to: 48 + 1 });
  assert.deepEqual((await white.next('match', (m) => m.snapshot.moves.length === 1)).snapshot.moves, ['b4']);

  // The browser can fetch the rules engine but not the server code.
  const get = async (path) => (await fetch(`http://localhost:${server.port}${path}`)).status;
  assert.equal(await get('/games/chess/shared/engine.js'), 200);
  assert.equal(await get('/games/chess/client/index.js'), 200);
  assert.equal(await get('/games/chess/server/match.js'), 404);
});

// The lobby, tested with a throwaway game so that nothing here depends on chess.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { connect, statuses } from './helpers.js';

const gamesDir = fileURLToPath(new URL('./fixtures/games', import.meta.url));

test('lobby, invitation and a match', async (t) => {
  const server = await startServer({ port: 0, gamesDir });
  t.after(() => server.close());
  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);

  alice.send({ type: 'join', name: 'alice' });
  const joined = await alice.next('joined');
  assert.equal(joined.name, 'alice');
  assert.equal(joined.resumed, false);
  assert.deepEqual(joined.games.map((g) => [g.id, g.name]), [['pick', 'Pick']]);

  bob.send({ type: 'join', name: ' Alice ' });
  assert.match((await bob.next('joinError')).message, /taken/);
  bob.send({ type: 'join', name: 'x' });
  await bob.next('joinError');
  bob.send({ type: 'join', name: 'bob' });
  await bob.next('joined');
  assert.deepEqual((await alice.next('users', (m) => m.users.length === 2)).users, [
    { name: 'alice', status: 'idle', game: null },
    { name: 'bob', status: 'idle', game: null },
  ]);

  // Unknown games, options the game refuses and self-invites are rejected.
  alice.send({ type: 'invite', to: 'bob', game: 'nope' });
  assert.match((await alice.next('error')).message, /Unknown game/);
  alice.send({ type: 'invite', to: 'bob', game: 'pick', options: { prize: 9 } });
  assert.match((await alice.next('error')).message, /prize/);
  alice.send({ type: 'invite', to: 'alice', game: 'pick' });
  await alice.next('error');

  // Declined invitation. The options come back as the game normalised them.
  alice.send({ type: 'invite', to: 'bob', game: 'pick', options: { prize: 2, junk: true } });
  let invite = await bob.next('invite');
  assert.deepEqual([invite.from, invite.game, invite.options], ['alice', 'pick', { prize: 2 }]);
  bob.send({ type: 'decline', id: invite.id });
  assert.equal((await alice.next('inviteClosed')).reason, 'declined');

  // Cancelled invitation.
  alice.send({ type: 'invite', to: 'bob', game: 'pick' });
  const sent = await alice.next('inviteSent');
  alice.send({ type: 'cancel', id: sent.id });
  assert.equal((await bob.next('inviteClosed', (m) => m.id === sent.id)).reason, 'cancelled');

  // Accepted invitation. The user list goes out before the match does.
  alice.send({ type: 'invite', to: 'bob', game: 'pick' });
  invite = await bob.next('invite');
  bob.send({ type: 'accept', id: invite.id });
  assert.deepEqual((await alice.next('users', (m) => m.users[0].status === 'busy')).users, [
    { name: 'alice', status: 'busy', game: 'pick' },
    { name: 'bob', status: 'busy', game: 'pick' },
  ]);
  const started = await Promise.all([alice.next('match'), bob.next('match')]);
  assert.deepEqual(started.map((m) => m.game), ['pick', 'pick']);
  assert.deepEqual(started.map((m) => m.snapshot.you).sort(), [0, 1]);
  assert.deepEqual(started[0].snapshot.options, { prize: 1 });

  // Busy players cannot be invited.
  const carol = connect(server.port);
  await carol.opened;
  carol.send({ type: 'join', name: 'carol' });
  await carol.next('joined');
  carol.send({ type: 'invite', to: 'bob', game: 'pick' });
  assert.match((await carol.next('error')).message, /busy/);

  // Actions go to the game, and its errors come back to the sender only.
  alice.send({ type: 'action', action: 'dance' });
  assert.match((await alice.next('error')).message, /Unknown action/);
  alice.send({ type: 'action', action: 'claim' });
  const ended = (await bob.next('match', (m) => m.snapshot.over)).snapshot;
  assert.equal(ended.over.winner, started[0].snapshot.you);
  const after = statuses(await carol.next('users', (m) => m.users.every((u) => u.status === 'idle')));
  assert.deepEqual(after, { alice: 'idle', bob: 'idle', carol: 'idle' });
});

test('reconnecting mid-match keeps the seat; staying away forfeits', async (t) => {
  const server = await startServer({ port: 0, gamesDir, graceMs: 200 });
  t.after(() => server.close());
  const alice = connect(server.port);
  let bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  const { token } = await bob.next('joined');
  await alice.next('users', (m) => m.users.length === 2);

  alice.send({ type: 'invite', to: 'bob', game: 'pick' });
  bob.send({ type: 'accept', id: (await bob.next('invite')).id });
  const bobSeat = (await bob.next('match')).snapshot.you;

  bob.close();
  assert.equal((await alice.next('match', (m) => !m.snapshot.connected[bobSeat])).snapshot.over, null);

  // Someone else cannot take the name without the token.
  const thief = connect(server.port);
  await thief.opened;
  thief.send({ type: 'join', name: 'bob' });
  await thief.next('joinError');

  bob = connect(server.port);
  await bob.opened;
  bob.send({ type: 'join', name: 'bob', token });
  assert.equal((await bob.next('joined')).resumed, true);
  assert.equal((await bob.next('match')).snapshot.you, bobSeat);
  await alice.next('match', (m) => m.snapshot.connected[bobSeat]);

  bob.close();
  const ended = (await alice.next('match', (m) => m.snapshot.over)).snapshot;
  assert.deepEqual(ended.over, { reason: 'abandoned', winner: 1 - bobSeat });
  assert.deepEqual(statuses(await alice.next('users', (m) => m.users.length === 1)), { alice: 'idle' });
});

test('only the browser parts of a game are served', async (t) => {
  const server = await startServer({ port: 0, gamesDir });
  t.after(() => server.close());
  const get = async (path) => (await fetch(`http://localhost:${server.port}${path}`)).status;
  assert.equal(await get('/'), 200);
  assert.equal(await get('/games/pick/meta.js'), 200);
  assert.equal(await get('/games/pick/server/index.js'), 404);
  assert.equal(await get('/games/pick/client/%2e%2e/server/index.js'), 404);
  assert.equal(await get('/games/nope/meta.js'), 404);
  assert.equal(await get('/%2e%2e/package.json'), 404);
});

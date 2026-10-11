import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

// A WebSocket client that lets a test wait for the next message it cares about.
function connect(port) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const queue = [];
  let waiter = null;
  const pump = () => {
    if (!waiter) return;
    const i = queue.findIndex(waiter.match);
    if (i === -1) return;
    const [msg] = queue.splice(0, i + 1).slice(-1);
    clearTimeout(waiter.timer);
    const { resolve } = waiter;
    waiter = null;
    resolve(msg);
  };
  ws.on('message', (raw) => {
    queue.push(JSON.parse(raw));
    pump();
  });
  return {
    opened: new Promise((resolve) => ws.once('open', resolve)),
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    // Resolves with the first message of `type` that satisfies `where`,
    // discarding everything queued before it.
    next(type, where = () => true) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), 3000);
        waiter = { match: (m) => m.type === type && where(m), resolve, timer };
        pump();
      });
    },
  };
}

const statuses = (msg) => Object.fromEntries(msg.users.map((u) => [u.name, u.status]));

test('lobby, invitation and a timed game', async (t) => {
  const server = await startServer({ port: 0, minMinutes: 0.001, graceMs: 200 });
  t.after(() => server.close());
  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);

  alice.send({ type: 'join', name: 'alice' });
  const joined = await alice.next('joined');
  assert.equal(joined.name, 'alice');

  bob.send({ type: 'join', name: ' Alice ' });
  assert.match((await bob.next('joinError')).message, /taken/);
  bob.send({ type: 'join', name: 'x' });
  await bob.next('joinError');
  bob.send({ type: 'join', name: 'bob' });
  await bob.next('joined');
  assert.deepEqual(statuses(await alice.next('users', (m) => m.users.length === 2)), { alice: 'idle', bob: 'idle' });

  // Out-of-range time controls and self-invites are refused.
  alice.send({ type: 'invite', to: 'bob', minutes: 500, increment: 1 });
  await alice.next('error');
  alice.send({ type: 'invite', to: 'alice', minutes: 3, increment: 1 });
  await alice.next('error');

  alice.send({ type: 'invite', to: 'bob', minutes: 3, increment: 1, variant: 'nope' });
  await alice.next('error');

  // Declined invitation.
  alice.send({ type: 'invite', to: 'bob', minutes: 3, increment: 1 });
  let invite = await bob.next('invite');
  assert.deepEqual([invite.from, invite.minutes, invite.increment], ['alice', 3, 1]);
  bob.send({ type: 'decline', id: invite.id });
  assert.equal((await alice.next('inviteClosed')).reason, 'declined');

  // Accepted invitation: 0.3 s on the clock, no increment.
  alice.send({ type: 'invite', to: 'bob', minutes: 0.005, increment: 0 });
  invite = await bob.next('invite');
  bob.send({ type: 'accept', id: invite.id });
  // The user list goes out before the game does.
  assert.deepEqual(statuses(await alice.next('users', (m) => m.users[0].status === 'busy')), { alice: 'busy', bob: 'busy' });
  const games = await Promise.all([alice.next('game'), bob.next('game')]);
  assert.deepEqual(games.map((m) => m.game.you).sort(), [0, 1]);
  assert.deepEqual(games[0].game.clocks, [300, 300]);
  const [white, black] = games[0].game.you === 0 ? [alice, bob] : [bob, alice];

  // Busy players cannot be invited.
  const carol = connect(server.port);
  await carol.opened;
  carol.send({ type: 'join', name: 'carol' });
  await carol.next('joined');
  carol.send({ type: 'invite', to: 'bob', minutes: 3, increment: 1 });
  assert.match((await carol.next('error')).message, /busy/);

  black.send({ type: 'move', from: 52, to: 36 });
  assert.match((await black.next('error')).message, /turn/);
  white.send({ type: 'move', from: 12, to: 36 });
  assert.match((await white.next('error')).message, /Illegal/);
  white.send({ type: 'move', from: 12, to: 28 });
  const afterMove = (await black.next('game', (m) => m.game.moves.length === 1)).game;
  assert.deepEqual(afterMove.moves, ['e4']);
  assert.equal(afterMove.running, 1);
  assert.deepEqual(afterMove.lastMove, { from: 12, to: 28 });

  // Black never moves and loses on time; both players become idle again.
  const ended = (await white.next('game', (m) => m.game.over)).game;
  assert.deepEqual(ended.over, { reason: 'timeout', winner: 0 });
  assert.equal(ended.clocks[1], 0);
  const after = statuses(await carol.next('users', (m) => m.users.every((u) => u.status === 'idle')));
  assert.deepEqual(after, { alice: 'idle', bob: 'idle', carol: 'idle' });
});

test('reconnecting mid-game keeps the seat; staying away forfeits', async (t) => {
  const server = await startServer({ port: 0, graceMs: 200 });
  t.after(() => server.close());
  const alice = connect(server.port);
  let bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  const { token } = await bob.next('joined');
  await alice.next('users', (m) => m.users.length === 2);

  alice.send({ type: 'invite', to: 'bob', minutes: 5, increment: 1 });
  bob.send({ type: 'accept', id: (await bob.next('invite')).id });
  const bobSeat = (await bob.next('game')).game.you;

  bob.close();
  assert.equal((await alice.next('game', (m) => !m.game.connected[bobSeat])).game.over, null);

  // Someone else cannot take the name without the token.
  const thief = connect(server.port);
  await thief.opened;
  thief.send({ type: 'join', name: 'bob' });
  await thief.next('joinError');

  bob = connect(server.port);
  await bob.opened;
  bob.send({ type: 'join', name: 'bob', token });
  assert.equal((await bob.next('game')).game.you, bobSeat);
  await alice.next('game', (m) => m.game.connected[bobSeat]);

  bob.close();
  const ended = (await alice.next('game', (m) => m.game.over)).game;
  assert.equal(ended.over.reason, 'abandoned');
  assert.equal(ended.over.winner, 1 - bobSeat);
  assert.deepEqual(statuses(await alice.next('users', (m) => m.users.length === 1)), { alice: 'idle' });
});

test('a 16x16 game can be requested in the invitation', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  await alice.next('users', (m) => m.users.length === 2);

  alice.send({ type: 'invite', to: 'bob', minutes: 5, increment: 1, variant: 'double' });
  const invite = await bob.next('invite');
  assert.equal(invite.variant, 'double');
  bob.send({ type: 'accept', id: invite.id });
  const games = await Promise.all([alice.next('game'), bob.next('game')]);
  assert.equal(games[0].game.variant, 'double');
  assert.equal(games[0].game.state.board.length, 256);

  // b2-b4 on the wide board: squares are numbered y * 16 + x.
  const white = games[0].game.you === 0 ? alice : bob;
  white.send({ type: 'move', from: 16 + 1, to: 48 + 1 });
  assert.deepEqual((await white.next('game', (m) => m.game.moves.length === 1)).game.moves, ['b4']);
});

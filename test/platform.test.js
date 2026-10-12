// The lobby, tested with a throwaway game so that nothing here depends on chess.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';
import { connect, statuses } from './helpers.js';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';

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

test('the players of a match can chat, also after it is over', async (t) => {
  const server = await startServer({ port: 0, gamesDir });
  t.after(() => server.close());
  let alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  const { token } = await alice.next('joined');
  await alice.next('users', (m) => m.users.length === 2);

  // Nobody to talk to yet, so this goes nowhere.
  alice.send({ type: 'chat', text: 'anyone?' });
  alice.send({ type: 'invite', to: 'bob', game: 'pick' });
  bob.send({ type: 'accept', id: (await bob.next('invite')).id });
  const { id } = (await bob.next('match')).snapshot;

  alice.send({ type: 'chat', text: '  good   luck  ' });
  const hello = { type: 'chat', id, from: 'alice', text: 'good luck' };
  assert.deepEqual(await bob.next('chat'), hello);
  assert.deepEqual(await alice.next('chat'), hello);

  // Too long, empty, not text, and too soon after the last one: all dropped.
  bob.send({ type: 'chat', text: 'x'.repeat(141) });
  bob.send({ type: 'chat', text: '   ' });
  bob.send({ type: 'chat', text: 7 });
  bob.send({ type: 'chat', text: 'thanks' });
  bob.send({ type: 'chat', text: 'too fast' });
  assert.equal((await alice.next('chat')).text, 'thanks');

  // Coming back to the match brings the conversation along.
  alice.close();
  alice = connect(server.port);
  await alice.opened;
  alice.send({ type: 'join', name: 'alice', token });
  assert.deepEqual(await alice.next('chatLog'), {
    type: 'chatLog',
    id,
    messages: [{ from: 'alice', text: 'good luck' }, { from: 'bob', text: 'thanks' }],
  });

  bob.send({ type: 'action', action: 'claim' });
  await alice.next('match', (m) => m.snapshot.over);
  await new Promise((resolve) => setTimeout(resolve, 550));
  bob.send({ type: 'chat', text: 'gg' });
  assert.deepEqual(await alice.next('chat'), { type: 'chat', id, from: 'bob', text: 'gg' });
});

test('watching a match', async (t) => {
  const server = await startServer({ port: 0, gamesDir });
  t.after(() => server.close());
  const [alice, bob, carol] = [connect(server.port), connect(server.port), connect(server.port)];
  await Promise.all([alice.opened, bob.opened, carol.opened]);
  for (const [client, name] of [[alice, 'alice'], [bob, 'bob'], [carol, 'carol']]) {
    client.send({ type: 'join', name });
    await client.next('joined');
  }
  assert.deepEqual((await carol.next('matches')).matches, []);
  carol.send({ type: 'watch', id: 'nope' });
  assert.match((await carol.next('error')).message, /no longer/);

  alice.send({ type: 'invite', to: 'bob', game: 'pick', options: { prize: 2 } });
  bob.send({ type: 'accept', id: (await bob.next('invite')).id });
  const { id, you } = (await alice.next('match')).snapshot;
  const [live] = (await carol.next('matches', (m) => m.matches.length === 1)).matches;
  assert.deepEqual({ ...live, players: [...live.players].sort() },
    { id, game: 'pick', players: ['alice', 'bob'], options: { prize: 2 }, preview: { claimed: false, pokes: 0 } });
  // Following a game brings its list, then every preview as it changes.
  carol.send({ type: 'follow', game: 'pick' });
  assert.equal((await carol.next('matches')).matches[0].id, id);
  alice.send({ type: 'action', action: 'poke' });
  assert.deepEqual(await carol.next('preview'), { type: 'preview', id, preview: { claimed: false, pokes: 1 } });
  carol.send({ type: 'unfollow' });

  // A player cannot watch; anyone else gets the match without a seat.
  alice.send({ type: 'watch', id });
  assert.match((await alice.next('error')).message, /in a game/);
  carol.send({ type: 'watch', id });
  const seen = (await carol.next('match')).snapshot;
  assert.deepEqual([seen.id, seen.you, seen.spectators], [id, null, 1]);
  assert.equal((await alice.next('match', (m) => m.snapshot.spectators === 1)).snapshot.you, you);

  // Nothing a spectator sends reaches the match or its chat.
  carol.send({ type: 'action', action: 'claim' });
  carol.send({ type: 'chat', text: 'psst' });
  carol.send({ type: 'unwatch' });
  assert.equal((await alice.next('match', (m) => m.snapshot.spectators === 0)).snapshot.over, null);

  // Watching again; the end of the match reaches the spectator too.
  carol.send({ type: 'watch', id });
  await carol.next('match');
  alice.send({ type: 'action', action: 'claim' });
  assert.deepEqual((await carol.next('match', (m) => m.snapshot.over)).snapshot.over, { reason: 'claimed', winner: you });
  assert.deepEqual((await carol.next('matches')).matches, []);
});

test('previews are not pushed while more than 12 matches are going', async (t) => {
  const server = await startServer({ port: 0, gamesDir });
  t.after(() => server.close());
  const join = async (name) => {
    const client = connect(server.port);
    await client.opened;
    client.send({ type: 'join', name });
    await client.next('joined');
    return client;
  };
  const watcher = await join('watcher');
  const hosts = [];
  for (let i = 0; i < 13; i++) {
    const [host, guest] = [await join(`host${i}`), await join(`guest${i}`)];
    host.send({ type: 'invite', to: `guest${i}`, game: 'pick' });
    guest.send({ type: 'accept', id: (await guest.next('invite')).id });
    await host.next('match');
    hosts.push(host);
  }
  watcher.send({ type: 'follow', game: 'pick' });
  await watcher.next('matches', (m) => m.matches.length === 13);

  // Thirteen matches: a change is not sent. One ends, and the next change is.
  hosts[0].send({ type: 'action', action: 'poke' });
  hosts[12].send({ type: 'action', action: 'claim' });
  await watcher.next('matches', (m) => m.matches.length === 12);
  hosts[1].send({ type: 'action', action: 'poke' });
  const { id, preview } = await watcher.next('preview');
  assert.deepEqual(preview, { claimed: false, pokes: 1 });
  const first = (await hosts[0].next('match')).snapshot.id;
  assert.notEqual(id, first);
});

test('finished matches are kept and can be looked at again', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'game-room-'));
  t.after(() => rm(dataDir, { recursive: true }));
  let server = await startServer({ port: 0, gamesDir, dataDir });
  t.after(() => server.close());
  const join = async (name) => {
    const client = connect(server.port);
    await client.opened;
    client.send({ type: 'join', name });
    await client.next('joined');
    return client;
  };
  const alice = await join('alice');
  const bob = await join('bob');

  alice.send({ type: 'history', game: 'pick' });
  assert.deepEqual(await alice.next('history'), { type: 'history', game: 'pick', before: null, games: [], more: false });

  alice.send({ type: 'invite', to: 'bob', game: 'pick', options: { prize: 3 } });
  bob.send({ type: 'accept', id: (await bob.next('invite')).id });
  const { id, you } = (await alice.next('match')).snapshot;
  // A match is not there to review until it is over, and never for a player.
  alice.send({ type: 'review', id });
  assert.match((await alice.next('error')).message, /in a game/);
  alice.send({ type: 'action', action: 'claim' });
  await alice.next('matches', (m) => m.matches.length === 0);

  const check = async (client) => {
    client.send({ type: 'history', game: 'pick', player: 'ALICE' });
    const [saved] = (await client.next('history')).games;
    assert.deepEqual({ ...saved, endedAt: 0, players: [...saved.players].sort() }, {
      id, endedAt: 0, players: ['alice', 'bob'], options: { prize: 3 }, over: { reason: 'claimed', winner: you },
      preview: { claimed: true, pokes: 0 }, seq: 0,
    });
    client.send({ type: 'history', game: 'pick', player: 'carol' });
    assert.deepEqual((await client.next('history')).games, []);
    client.send({ type: 'review', id });
    const { snapshot } = await client.next('match');
    assert.deepEqual([snapshot.id, snapshot.you, snapshot.over.winner], [id, null, you]);
    client.send({ type: 'review', id: 'nope' });
    assert.match((await client.next('error')).message, /not be found/);
  };
  await check(bob);

  // The match is still there after the server has been restarted.
  server.close();
  assert.equal((await readFile(path.join(dataDir, 'pick.jsonl'), 'utf8')).trim().split('\n').length, 1);
  server = await startServer({ port: 0, gamesDir, dataDir });
  await check(await join('dave'));
});

test('only the browser parts of a game are served', async (t) => {
  const server = await startServer({ port: 0, gamesDir });
  t.after(() => server.close());
  const get = async (path) => (await fetch(`http://localhost:${server.port}${path}`)).status;
  assert.equal(await get('/'), 200);
  const type = async (path) => (await fetch(`http://localhost:${server.port}${path}`)).headers.get('content-type');
  assert.equal(await type('/sound/Move.mp3'), 'audio/mpeg');
  assert.equal(await get('/games/pick/meta.js'), 200);
  assert.equal(await get('/games/pick/server/index.js'), 404);
  assert.equal(await get('/games/pick/client/%2e%2e/server/index.js'), 404);
  assert.equal(await get('/games/nope/meta.js'), 404);
  assert.equal(await get('/%2e%2e/package.json'), 404);
});

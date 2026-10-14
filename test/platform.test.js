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

test('a match against a bot, whose seat the player\'s browser plays', async (t) => {
  const server = await startServer({ port: 0, gamesDir });
  t.after(() => server.close());
  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  await Promise.all([alice.next('joined'), bob.next('joined')]);

  // The game decides what a bot may be.
  alice.send({ type: 'bot', game: 'nope' });
  assert.match((await alice.next('error')).message, /Unknown game/);
  alice.send({ type: 'bot', game: 'pick', options: { prize: 9 }, bot: { mood: 'calm' } });
  assert.match((await alice.next('error')).message, /prize/);
  alice.send({ type: 'bot', game: 'pick', bot: { mood: 'sad' } });
  assert.match((await alice.next('error')).message, /calm or wild/);

  // Starting one withdraws the invitation that was waiting.
  alice.send({ type: 'invite', to: 'bob', game: 'pick' });
  const invite = await bob.next('invite');
  alice.send({ type: 'bot', game: 'pick', options: { prize: 2 }, bot: { mood: 'calm', junk: 1 }, seat: 1 });
  assert.equal((await bob.next('inviteClosed', (m) => m.id === invite.id)).reason, 'unavailable');
  const { snapshot } = await alice.next('match');
  assert.deepEqual([snapshot.players, snapshot.bots, snapshot.you], [['calm bot', 'alice'], [{ mood: 'calm' }, null], 1]);
  assert.deepEqual(snapshot.options, { prize: 2 });

  // The bot is not a user, but its match is there to be watched.
  assert.deepEqual(statuses(await bob.next('users', (m) => m.users.some((u) => u.status === 'busy'))),
    { alice: 'busy', bob: 'idle' });
  const live = (await bob.next('matches', (m) => m.matches.length === 1)).matches[0];
  assert.deepEqual(live.players, ['calm bot', 'alice']);
  alice.send({ type: 'bot', game: 'pick', bot: { mood: 'wild' } });
  assert.match((await alice.next('error')).message, /already in a game/);

  // Only the player facing the bot can act for it.
  bob.send({ type: 'action', action: 'claim', bot: true });
  alice.send({ type: 'action', action: 'claim', bot: true });
  const ended = (await alice.next('match', (m) => m.snapshot.over)).snapshot;
  assert.equal(ended.over.winner, 0);
  assert.deepEqual(statuses(await bob.next('users', (m) => m.users.every((u) => u.status === 'idle'))),
    { alice: 'idle', bob: 'idle' });

  // The seat is random unless asked for, and marking an action does nothing
  // in a match between people.
  alice.send({ type: 'bot', game: 'pick', bot: { mood: 'wild' }, seat: 0 });
  const again = (await alice.next('match', (m) => !m.snapshot.over)).snapshot;
  assert.deepEqual([again.players, again.you], [['alice', 'wild bot'], 0]);
  alice.send({ type: 'action', action: 'claim' });
  assert.equal((await alice.next('match', (m) => m.snapshot.over)).snapshot.over.winner, 0);
  // Games against the computer are not kept.
  alice.send({ type: 'history', game: 'pick' });
  assert.deepEqual((await alice.next('history')).games, []);
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

  // A match that ends before any move is not kept.
  alice.send({ type: 'invite', to: 'bob', game: 'pick' });
  bob.send({ type: 'accept', id: (await bob.next('invite')).id });
  await alice.next('match');
  alice.send({ type: 'action', action: 'resign' });
  await alice.next('match', (m) => m.snapshot.over);
  alice.send({ type: 'history', game: 'pick' });
  assert.deepEqual((await alice.next('history')).games, []);

  alice.send({ type: 'invite', to: 'bob', game: 'pick', options: { prize: 3 } });
  bob.send({ type: 'accept', id: (await bob.next('invite')).id });
  const { id, you } = (await alice.next('match', (m) => !m.snapshot.over)).snapshot;
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

test('an update: the restart is announced, new games wait, and so does the restart', async (t) => {
  const server = await startServer({ port: 0, gamesDir, adminToken: 'secret' });
  t.after(() => server.close());
  const call = async (method, path, token = 'secret') => {
    const res = await fetch(`http://localhost:${server.port}${path}`, {
      method, headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: res.headers.get('content-type') === 'application/json' ? await res.json() : null };
  };
  // Without the right token the admin interface is not there.
  assert.equal((await call('GET', '/admin/status', null)).status, 404);
  assert.equal((await call('GET', '/admin/status', 'wrong')).status, 404);
  assert.deepEqual((await call('GET', '/admin/status')).body, { restart: null, games: 0, players: 0 });
  assert.equal((await call('POST', '/admin/restart?in=-1')).status, 400);

  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  await alice.next('users', (m) => m.users.length === 2);
  alice.send({ type: 'invite', to: 'bob', game: 'pick' });
  const invite = await bob.next('invite');
  bob.send({ type: 'accept', id: invite.id });
  await Promise.all([alice.next('match'), bob.next('match')]);
  // A second invitation, still open when the restart is announced.
  const carol = connect(server.port);
  const dave = connect(server.port);
  await Promise.all([carol.opened, dave.opened]);
  carol.send({ type: 'join', name: 'carol' });
  dave.send({ type: 'join', name: 'dave' });
  await carol.next('users', (m) => m.users.length === 4);
  carol.send({ type: 'invite', to: 'dave', game: 'pick' });
  await dave.next('invite');

  // Announced: everyone hears, open invitations close, nothing new starts.
  let status = (await call('POST', '/admin/restart?in=300')).body;
  assert.equal(status.games, 1);
  assert.equal(status.restart.ready, false);
  assert.ok(status.restart.msLeft > 299_000 && status.restart.msLeft <= 300_000);
  const notice = await carol.next('restart');
  assert.ok(notice.msLeft > 299_000);
  assert.equal(notice.games, 1);
  assert.equal((await dave.next('inviteClosed')).reason, 'unavailable');
  carol.send({ type: 'invite', to: 'dave', game: 'pick' });
  assert.match((await carol.next('error')).message, /restarts for an update/);
  carol.send({ type: 'bot', game: 'pick', options: {} });
  assert.match((await carol.next('error')).message, /restarts for an update/);
  // Someone arriving now is told as well.
  const erin = connect(server.port);
  await erin.opened;
  erin.send({ type: 'join', name: 'erin' });
  assert.ok((await erin.next('restart')).msLeft > 0);

  // Brought forward, the time is up, but a game is still being played.
  status = (await call('POST', '/admin/restart?in=0')).body;
  assert.deepEqual(status.restart, { msLeft: 0, games: 1, ready: false });
  // When it ends, the restart may go ahead.
  alice.send({ type: 'action', action: 'claim' });
  assert.deepEqual(await carol.next('restart', (m) => m.games === 0), { type: 'restart', msLeft: 0, games: 0 });
  assert.equal((await call('GET', '/admin/status')).body.restart.ready, true);

  // Called off: new games may start again.
  await call('DELETE', '/admin/restart');
  assert.equal((await carol.next('restart')).msLeft, null);
  carol.send({ type: 'invite', to: 'dave', game: 'pick' });
  assert.equal((await dave.next('invite')).from, 'carol');
});

test('someone playing the computer can be invited; accepting ends that game', async (t) => {
  const server = await startServer({ port: 0, gamesDir });
  t.after(() => server.close());
  const [alice, bob, carol, dave] = ['alice', 'bob', 'carol', 'dave'].map(() => connect(server.port));
  await Promise.all([alice, bob, carol, dave].map((c) => c.opened));
  for (const [c, name] of [[alice, 'alice'], [bob, 'bob'], [carol, 'carol'], [dave, 'dave']]) c.send({ type: 'join', name });
  await bob.next('users', (m) => m.users.length === 4);

  // Alice plays the computer; Carol and Dave play each other.
  alice.send({ type: 'bot', game: 'pick', bot: { mood: 'calm' }, seat: 0 });
  const botGame = (await alice.next('match')).snapshot;
  carol.send({ type: 'invite', to: 'dave', game: 'pick' });
  dave.send({ type: 'accept', id: (await dave.next('invite')).id });
  await carol.next('match');
  const users = (await bob.next('users', (m) => m.users.filter((u) => u.status === 'busy').length === 3)).users;
  assert.deepEqual(users.find((u) => u.name === 'alice'), { name: 'alice', status: 'busy', game: 'pick', vsBot: true });
  assert.equal(users.find((u) => u.name === 'carol').vsBot, undefined);

  // Carol is in a game with a person: still busy. Alice may be asked.
  bob.send({ type: 'invite', to: 'carol', game: 'pick' });
  assert.match((await bob.next('error')).message, /busy/);
  bob.send({ type: 'invite', to: 'alice', game: 'pick' });
  const invite = await alice.next('invite');
  // Someone in a game cannot send invitations, even against the computer.
  alice.send({ type: 'invite', to: 'bob', game: 'pick' });
  assert.match((await alice.next('error')).message, /already in a game/);

  // Accepting: the game against the computer ends as left, and the new one starts.
  alice.send({ type: 'accept', id: invite.id });
  const ended = (await alice.next('match', (m) => m.snapshot.id === botGame.id && m.snapshot.over)).snapshot;
  assert.deepEqual(ended.over, { reason: 'abandoned', winner: 1 });
  const next = (await alice.next('match', (m) => m.snapshot.id !== botGame.id)).snapshot;
  assert.deepEqual(next.players.slice().sort(), ['alice', 'bob']);
  assert.deepEqual(next.bots, [null, null]);
  bob.send({ type: 'history', game: 'pick' });
  assert.ok(!(await bob.next('history')).games.some((g) => g.id === botGame.id));
});

// The admin panel: the password and what guards it, the statistics, taking
// a game out of the archive, and the panel's requests.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { hashPassword, verifyPassword, LoginGuard, Sessions } from '../server/auth.js';
import { Stats } from '../server/stats.js';
import { Archive } from '../server/archive.js';
import { startServer } from '../server/index.js';
import { connect } from './helpers.js';

const gamesDir = fileURLToPath(new URL('./fixtures/games', import.meta.url));

function clock(start = new Date(2026, 9, 14, 12).getTime()) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'game-room-admin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('passwords are kept as scrypt hashes', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$32768\$8\$1\$[^$]+\$[^$]+$/);
  assert.notEqual(hash, await hashPassword('correct horse battery'));
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('correct horse batterz', hash), false);
  assert.equal(await verifyPassword('anything', 'plain text'), false);
  assert.equal(await verifyPassword('anything', 'scrypt$1$1$1$$'), false);
});

test('wrong passwords make an address wait longer and longer', () => {
  const now = clock();
  const guard = new LoginGuard({ now, freeTries: 3, maxWaitMs: 8000, globalLimit: 100 });
  for (let i = 0; i < 3; i++) {
    assert.equal(guard.waitFor('a'), 0);
    guard.failed('a');
  }
  assert.equal(guard.waitFor('a'), 0);
  guard.failed('a');
  assert.equal(guard.waitFor('a'), 1000);
  guard.failed('a');
  assert.equal(guard.waitFor('a'), 2000);
  guard.failed('a');
  guard.failed('a');
  guard.failed('a');
  assert.equal(guard.waitFor('a'), 8000);
  // Others are not held up, and getting it right starts afresh.
  assert.equal(guard.waitFor('b'), 0);
  guard.succeeded('a');
  assert.equal(guard.waitFor('a'), 0);
  // A day later an address is forgotten.
  guard.failed('c');
  guard.failed('c');
  guard.failed('c');
  guard.failed('c');
  now.advance(25 * 60 * 60_000);
  guard.failed('d');
  assert.equal(guard.byAddress.has('c'), false);
});

test('too many wrong passwords from anywhere make everyone wait', () => {
  const now = clock();
  const guard = new LoginGuard({ now, globalLimit: 5, globalWindowMs: 60_000 });
  for (let i = 0; i < 5; i++) guard.failed(`address ${i}`);
  assert.equal(guard.waitFor('somebody new'), 60_000);
  now.advance(60_001);
  assert.equal(guard.waitFor('somebody new'), 0);
});

test('sessions end when idle, when old, and when the password changes', () => {
  const now = clock();
  const sessions = new Sessions({ now, idleMs: 1000, maxMs: 5000 });
  const id = sessions.create('hash');
  assert.ok(sessions.check(id, 'hash'));
  assert.equal(sessions.check(id, 'another hash'), null);
  assert.equal(sessions.check(id, 'hash'), null);
  const idle = sessions.create('hash');
  now.advance(1001);
  assert.equal(sessions.check(idle, 'hash'), null);
  const old = sessions.create('hash');
  for (let i = 0; i < 6; i++) {
    now.advance(900);
    sessions.check(old, 'hash');
  }
  assert.equal(sessions.check(old, 'hash'), null);
  assert.equal(sessions.check('made up', 'hash'), null);
  assert.equal(sessions.check(undefined, 'hash'), null);
});

test('statistics: counted per day and hour, kept across restarts and days', async (t) => {
  const dir = await tempDir(t);
  const now = clock();
  let stats = new Stats({ dir, now, version: 'v1' });
  await stats.load();
  stats.connected();
  stats.joined('Alice');
  stats.joined('alice');
  stats.joined('Bob');
  stats.onlineNow(2);
  stats.onlineNow(1);
  stats.chat();
  stats.dropped();
  stats.matchStarted({ game: 'chess', options: { variant: 'standard', minutes: 5, junk: { nested: true } }, bots: [null, null] });
  stats.matchEnded({ game: 'chess', bots: [null, null], over: { reason: 'resign', winner: 0 }, durationMs: 60_000 });
  stats.matchStarted({ game: 'chess', options: { variant: 'atomic', minutes: 5 }, bots: [null, { level: 3 }] });
  stats.matchEnded({ game: 'chess', bots: [null, { level: 3 }], over: { reason: 'checkmate', winner: 1 }, durationMs: 30_000 });
  stats.matchStarted({ game: 'go', options: {}, bots: [{ level: 2 }, null] });
  stats.matchEnded({ game: 'go', bots: [{ level: 2 }, null], over: { reason: 'agreement', winner: null }, durationMs: 1000 });
  stats.sample(42.4, 120.6);
  let [today] = stats.days(1);
  assert.deepEqual([today.players, today.peakOnline, today.connections, today.chat, today.dropped], [2, 2, 1, 1, 1]);
  assert.deepEqual(today.games.chess, {
    started: 2,
    finished: 2,
    vsBot: 1,
    durationMs: 90_000,
    reasons: { resign: 1, checkmate: 1 },
    options: { variant: { standard: 1, atomic: 1 }, minutes: { 5: 2 } },
    bots: { 3: { games: 1, botWins: 1, draws: 0 } },
  });
  assert.deepEqual(today.games.go.bots, { 2: { games: 1, botWins: 0, draws: 1 } });
  assert.deepEqual(today.server, { starts: 1, updates: 0, errors: 0, lagMaxMs: 42, rssMaxMb: 121 });
  const [hour] = stats.lastHours();
  assert.deepEqual([hour.peakOnline, hour.players, hour.games], [2, 2, 3]);

  // A restart, on a new version, carries on with the same day.
  await stats.save();
  stats = new Stats({ dir, now, version: 'v2' });
  await stats.load();
  [today] = stats.days(1);
  assert.deepEqual([today.players, today.server.starts, today.server.updates], [2, 2, 1]);
  stats.joined('alice');
  assert.equal(stats.days(1)[0].players, 2);

  // The next day starts afresh, and the last one goes into the history.
  now.advance(24 * 60 * 60_000);
  stats.joined('alice');
  const days = stats.days(10);
  assert.deepEqual(days.map((d) => d.players), [2, 1]);
  await stats.save();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const history = (await readFile(path.join(dir, 'stats.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(history.length, 1);
  assert.equal(JSON.parse(history[0]).day, '2026-10-14');
  stats = new Stats({ dir, now, version: 'v2' });
  await stats.load();
  assert.deepEqual(stats.days(10).map((d) => d.day), ['2026-10-14', '2026-10-15']);
});

test('a game can be taken out of the archive while it is in use', async (t) => {
  const dir = await tempDir(t);
  const archive = new Archive({ dir });
  await archive.load(['pick']);
  const record = (id) => ({ id, game: 'pick', endedAt: 1, players: ['a', 'b'], options: {}, over: { winner: 0 }, snapshot: { id, big: 'x'.repeat(50) } });
  archive.save(record('one'));
  archive.save(record('two'));
  archive.save(record('three'));
  assert.equal(await archive.delete('two'), true);
  // Saved while the file is being rewritten.
  archive.save(record('four'));
  assert.equal(await archive.delete('nope'), false);
  assert.deepEqual(archive.list('pick').games.map((g) => [g.id, g.seq]), [['four', 2], ['three', 1], ['one', 0]]);
  for (const id of ['one', 'three', 'four']) assert.equal((await archive.get(id)).snapshot.id, id);
  assert.equal(await archive.get('two'), null);
  // And the file holds just the same, read afresh.
  const again = new Archive({ dir });
  await again.load(['pick']);
  assert.deepEqual(again.list('pick').games.map((g) => g.id), ['four', 'three', 'one']);
  assert.equal((await again.get('four')).snapshot.id, 'four');
});

test('the admin panel: logging in, what it shows, and what it does', async (t) => {
  const dir = await tempDir(t);
  const passwordFile = path.join(dir, 'admin-password');
  const now = clock(Date.now());
  const server = await startServer({
    port: 0, gamesDir, passwordFile, panelOptions: { guard: new LoginGuard({ now, freeTries: 2 }) },
  });
  t.after(() => server.close());
  const base = `http://localhost:${server.port}`;
  const request = async (method, url, { body, cookie, headers = {} } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
  };

  // The page is there for anyone; it holds nothing secret.
  const page = await request('GET', '/admin');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');

  // No password yet: nobody can log in.
  assert.equal((await request('GET', '/admin/api/session')).body.passwordSet, false);
  assert.equal((await request('POST', '/admin/api/login', { body: { password: 'x' } })).status, 409);
  await writeFile(passwordFile, await hashPassword('the right password'));
  const { seen: _, ...session } = (await request('GET', '/admin/api/session')).body;
  assert.deepEqual(session, { loggedIn: false, passwordSet: true, https: true, retryAfterMs: 0 });
  assert.equal((await request('GET', '/admin/api/overview')).status, 401);

  // Through the proxy over plain HTTP: refused before the password is looked at.
  const viaProxy = (proto, address = '203.0.113.5') => ({ 'x-forwarded-for': `10.0.0.1, ${address}`, 'x-forwarded-proto': proto });
  assert.equal((await request('POST', '/admin/api/login', { body: { password: 'the right password' }, headers: viaProxy('http') })).status, 403);
  // Not JSON, or from another site: refused.
  const form = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=x' });
  assert.equal(form.status, 403);
  assert.equal((await request('POST', '/admin/api/login', { body: { password: 'x' }, headers: { origin: 'https://evil.example' } })).status, 403);

  // Wrong passwords over HTTPS: two free tries, then waiting, per address.
  const wrong = () => request('POST', '/admin/api/login', { body: { password: 'guess' }, headers: viaProxy('https') });
  assert.equal((await wrong()).status, 401);
  assert.equal((await wrong()).body.retryAfterMs, 0);
  const third = await wrong();
  assert.deepEqual([third.status, third.body.retryAfterMs], [401, 1000]);
  const held = await request('POST', '/admin/api/login', { body: { password: 'the right password' }, headers: viaProxy('https') });
  assert.deepEqual([held.status, held.headers.get('retry-after')], [429, '1']);
  // Another address is not held up.
  const ok = await request('POST', '/admin/api/login', { body: { password: 'the right password' }, headers: viaProxy('https', '198.51.100.7') });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Path=\/admin/);
  const cookie = setCookie.split(';')[0];
  const https = viaProxy('https', '198.51.100.7');

  // A game is played and finished, to show up in what the panel reads.
  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  await alice.next('users', (m) => m.users.length === 2);
  alice.send({ type: 'invite', to: 'bob', game: 'pick' });
  bob.send({ type: 'accept', id: (await bob.next('invite')).id });
  await alice.next('match');
  let overview = (await request('GET', '/admin/api/overview', { cookie, headers: https })).body;
  assert.deepEqual(overview.players.map((p) => [p.name, p.game]), [['alice', 'pick'], ['bob', 'pick']]);
  assert.deepEqual([overview.matches.length, overview.matches[0].players.sort()], [1, ['alice', 'bob']]);
  assert.deepEqual([overview.restart, overview.updates.available], [null, false]);
  assert.ok(overview.memoryMb > 0);
  alice.send({ type: 'action', action: 'claim' });
  await alice.next('match', (m) => m.snapshot.over);

  const stats = (await request('GET', '/admin/api/stats?days=7', { cookie, headers: https })).body;
  const today = stats.days.at(-1);
  assert.deepEqual([today.players, today.games.pick.started, today.games.pick.finished], [2, 1, 1]);
  assert.ok(stats.hours.length >= 1);

  const records = (await request('GET', '/admin/api/records?game=pick', { cookie, headers: https })).body;
  assert.equal(records.games.length, 1);
  const id = records.games[0].id;
  // Deleting needs JSON from the panel itself.
  assert.equal((await fetch(`${base}/admin/api/records/delete`, { method: 'POST', headers: { cookie, ...https }, body: id })).status, 403);
  assert.equal((await request('POST', '/admin/api/records/delete', { cookie, headers: https, body: { id } })).status, 200);
  assert.equal((await request('POST', '/admin/api/records/delete', { cookie, headers: https, body: { id } })).status, 404);
  assert.equal((await request('GET', '/admin/api/records?game=pick', { cookie, headers: https })).body.games.length, 0);

  // Updates need the deploy script; calling one off does not.
  assert.equal((await request('POST', '/admin/api/update', { cookie, headers: https, body: { action: 'check' } })).status, 409);
  assert.equal((await request('POST', '/admin/api/update', { cookie, headers: https, body: { action: 'cancel' } })).status, 200);

  // The diagnostic says what was seen, and X-Real-IP wins over X-Forwarded-For.
  const seen = (await request('GET', '/admin/api/session', { headers: { ...viaProxy('https'), 'x-real-ip': '192.0.2.9' } })).body.seen;
  assert.deepEqual(seen, {
    connectionFrom: seen.connectionFrom,
    xRealIp: '192.0.2.9',
    xForwardedFor: '10.0.0.1, 203.0.113.5',
    xForwardedProto: 'https',
    takenAs: { address: '192.0.2.9', https: true, throughProxy: true },
  });

  // A changed password ends the session; logging out does too.
  await writeFile(passwordFile, await hashPassword('a new password'));
  assert.equal((await request('GET', '/admin/api/overview', { cookie, headers: https })).status, 401);
  const again = await request('POST', '/admin/api/login', { body: { password: 'a new password' }, headers: https });
  const cookie2 = again.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('GET', '/admin/api/overview', { cookie: cookie2, headers: https })).status, 200);
  await request('POST', '/admin/api/logout', { cookie: cookie2, headers: https, body: {} });
  assert.equal((await request('GET', '/admin/api/overview', { cookie: cookie2, headers: https })).status, 401);
});

test('a proxy that sends only X-Real-IP, from an address of its own, vouched for as HTTPS', async (t) => {
  const dir = await tempDir(t);
  const passwordFile = path.join(dir, 'admin-password');
  await writeFile(passwordFile, await hashPassword('the right password'));
  const start = async (panelOptions) => {
    const server = await startServer({ port: 0, gamesDir, passwordFile, panelOptions });
    t.after(() => server.close());
    return server;
  };
  const session = async (server, headers) => (await (await fetch(`http://127.0.0.1:${server.port}/admin/api/session`, { headers })).json()).seen;

  // Not listed as a proxy: its headers count for nothing.
  let server = await start({ proxies: ['192.0.2.1'], proxyHttps: true });
  let seen = await session(server, { 'x-real-ip': '203.0.113.5' });
  assert.deepEqual(seen.takenAs, { address: '127.0.0.1', https: true, throughProxy: false });

  // Listed: X-Real-IP is the visitor, and with no X-Forwarded-Proto the
  // proxy's word that it serves only HTTPS is taken.
  server = await start({ proxies: ['127.0.0.1'], proxyHttps: true });
  seen = await session(server, { 'x-real-ip': '203.0.113.5' });
  assert.deepEqual(seen.takenAs, { address: '203.0.113.5', https: true, throughProxy: true });
  // An X-Forwarded-Proto that says http still counts.
  seen = await session(server, { 'x-real-ip': '203.0.113.5', 'x-forwarded-proto': 'http' });
  assert.equal(seen.takenAs.https, false);
});

// Feedback: what is accepted, the limits against floods, keeping it, and
// reading it in the admin panel.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { FeedbackBox } from '../server/feedback.js';
import { hashPassword } from '../server/auth.js';
import { startServer } from '../server/index.js';
import { connect } from './helpers.js';

const gamesDir = fileURLToPath(new URL('./fixtures/games', import.meta.url));

function clock() {
  let t = Date.UTC(2026, 9, 14, 12);
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'game-room-feedback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('what feedback is accepted', () => {
  const box = new FeedbackBox({ now: clock() });
  const send = (fields) => box.add({ name: 'Alice', address: '1.1.1.1', kind: 'idea', text: 'A fine idea', ...fields });
  assert.match(send({ text: '  ' }).error, /few words/);
  assert.match(send({ text: 'x'.repeat(1001) }).error, /1000/);
  assert.match(send({ kind: 'rant' }).error, /kind/);
  assert.match(send({ kind: 'constructor' }).error, /kind/);
  const { message } = send({ text: '  Two   spaces\n\n\n\nand lines  ', game: '../etc' });
  assert.deepEqual([message.name, message.kind, message.text, message.game, message.read],
    ['Alice', 'idea', 'Two spaces\n\nand lines', null, false]);
  assert.equal(box.unread(), 1);
});

test('the limits: a minute apart, five a day per name, ten per address, 200 in all', () => {
  const now = clock();
  const box = new FeedbackBox({ now, perDay: 12 });
  const send = (name, address, text = `message ${now()}`) => box.add({ name, address, kind: 'bug', text });
  assert.ok(send('alice', 'a').message);
  const soon = send('ALICE', 'a');
  assert.match(soon.error, /wait a minute/);
  assert.equal(soon.retryAfterMs, 60_000);
  now.advance(60_000);
  // The same text again is not taken.
  const first = box.list()[0].text;
  assert.match(send('alice', 'a', first).error, /already/);
  for (let i = 0; i < 4; i++) {
    assert.ok(send('alice', 'a').message, `message ${i + 2}`);
    now.advance(60_000);
  }
  assert.match(send('alice', 'a').error, /tomorrow/);
  // Another name from the same address: counted together, ten a day.
  for (let i = 0; i < 5; i++) assert.ok(send(`bob${i}`, 'a').message);
  assert.match(send('carol', 'a').error, /tomorrow/);
  // From elsewhere, the day's total is reached.
  assert.ok(send('dave', 'b').message);
  assert.ok(send('erin', 'c').message);
  assert.match(send('frank', 'd').error, /full for today/);
  // A day later it all starts again.
  now.advance(24 * 60 * 60_000);
  assert.ok(send('alice', 'a').message);
});

test('feedback is kept, marked read and deleted', async (t) => {
  const dir = await tempDir(t);
  const box = new FeedbackBox({ dir, now: clock() });
  await box.load();
  const one = box.add({ name: 'a', address: '1', kind: 'bug', text: 'first one' }).message;
  const two = box.add({ name: 'b', address: '2', kind: 'idea', text: 'second one' }).message;
  assert.deepEqual(box.list().map((m) => m.id), [two.id, one.id]);
  assert.equal(await box.markRead(one.id, true), true);
  assert.deepEqual(box.list({ unread: true }).map((m) => m.id), [two.id]);
  assert.equal(await box.delete(two.id), true);
  assert.equal(await box.delete(two.id), false);
  assert.equal(await box.markRead('nope', true), false);
  const again = new FeedbackBox({ dir });
  await again.load();
  assert.deepEqual(again.list().map((m) => [m.id, m.read]), [[one.id, true]]);
});

test('sent by a player, read in the admin panel', async (t) => {
  const dir = await tempDir(t);
  const passwordFile = path.join(dir, 'admin-password');
  await writeFile(passwordFile, await hashPassword('the right password'));
  const server = await startServer({ port: 0, gamesDir, dataDir: dir, passwordFile });
  t.after(() => server.close());

  const alice = connect(server.port);
  await alice.opened;
  // Only someone who has joined can send.
  alice.send({ type: 'feedback', kind: 'idea', text: 'Before joining' });
  alice.send({ type: 'join', name: 'alice' });
  await alice.next('joined');
  alice.send({ type: 'feedback', kind: 'idea', text: 'Please add checkers', game: 'pick' });
  // Thanks, and how long until the next one is taken.
  assert.deepEqual(await alice.next('feedbackSent'), { type: 'feedbackSent', ok: true, error: null, retryAfterMs: 60_000 });
  alice.send({ type: 'feedback', kind: 'bug', text: 'And another thing' });
  const held = await alice.next('feedbackSent');
  assert.equal(held.ok, false);
  assert.ok(held.retryAfterMs > 0);

  const base = `http://localhost:${server.port}`;
  const login = await fetch(`${base}/admin/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'the right password' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const get = async (url) => (await fetch(base + url, { headers: { cookie } })).json();
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  assert.equal((await fetch(`${base}/admin/api/feedback`)).status, 401);
  let list = await get('/admin/api/feedback');
  assert.equal(list.unread, 1);
  assert.deepEqual(list.messages.map((m) => [m.name, m.kind, m.text, m.game]), [['alice', 'idea', 'Please add checkers', 'pick']]);
  assert.equal((await get('/admin/api/overview')).unreadFeedback, 1);
  const { id } = list.messages[0];
  assert.equal((await post('/admin/api/feedback/read', { id, read: true })).status, 200);
  assert.deepEqual((await get('/admin/api/feedback?unread=1')).messages, []);
  assert.equal((await post('/admin/api/feedback/delete', { id })).status, 200);
  assert.equal((await post('/admin/api/feedback/delete', { id })).status, 404);
  list = await get('/admin/api/feedback');
  assert.deepEqual([list.messages, list.unread], [[], 0]);
});

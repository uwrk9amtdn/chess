// The archive of finished matches, on disk and in memory.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { Archive } from '../server/archive.js';

const record = (n, players = ['ann', 'ben']) => ({
  id: `m${n}`, game: 'pick', endedAt: 1000 + n, players, options: { prize: 1 }, over: { winner: 0 }, snapshot: { id: `m${n}`, n },
});

test('saving, listing and reading back', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'archive-'));
  t.after(() => rm(dir, { recursive: true }));
  const preview = (game, snapshot) => `${game} ${snapshot.n}`;
  let archive = new Archive({ dir, preview });
  await archive.load(['pick']);
  for (let n = 0; n < 5; n++) archive.save(record(n, n === 2 ? ['Cy', 'ann'] : undefined));

  const ids = (page) => page.games.map((m) => m.id);
  assert.deepEqual(ids(archive.list('pick')), ['m4', 'm3', 'm2', 'm1', 'm0']);
  assert.equal(archive.list('pick').games[0].snapshot, undefined);
  assert.equal(archive.list('pick').games[0].preview, 'pick 4');
  // Two at a time: `before` is the seq of the last match of the page before.
  const first = archive.list('pick', { limit: 2 });
  assert.deepEqual([ids(first), first.more], [['m4', 'm3'], true]);
  const rest = archive.list('pick', { limit: 4, before: first.games[1].seq });
  assert.deepEqual([ids(rest), rest.more], [['m2', 'm1', 'm0'], false]);
  assert.deepEqual(ids(archive.list('pick', { player: 'cy' })), ['m2']);
  assert.deepEqual(archive.list('other'), { games: [], more: false });
  assert.deepEqual(await archive.get('m3'), record(3));
  assert.equal(await archive.get('nope'), null);

  // A line that is damaged or was cut short is skipped; the rest still loads.
  await archive.writing;
  await appendFile(archive.file('pick'), '{"id":"broken"');
  archive = new Archive({ dir, preview });
  await archive.load(['pick', 'other']);
  // Previews are made afresh from what was saved.
  assert.equal(archive.list('pick').games[4].preview, 'pick 0');
  assert.deepEqual(ids(archive.list('pick')), ['m4', 'm3', 'm2', 'm1', 'm0']);
  assert.deepEqual(await archive.get('m0'), record(0));
  archive.save(record(5));
  assert.deepEqual(await archive.get('m5'), record(5));
  archive = new Archive({ dir });
  await archive.load(['pick']);
  assert.deepEqual(ids(archive.list('pick', { limit: 2 })), ['m5', 'm4']);
});

test('without a directory the matches are kept in memory', async () => {
  const archive = new Archive();
  await archive.load(['pick']);
  archive.save(record(1));
  assert.deepEqual(archive.list('pick').games.map((m) => m.id), ['m1']);
  assert.deepEqual((await archive.get('m1')).snapshot, { id: 'm1', n: 1 });
});

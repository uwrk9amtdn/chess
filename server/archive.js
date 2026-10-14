// Every finished match, kept for good so it can be looked at again later.
//
// Each game has one file, <dir>/<game id>.jsonl, with one match per line:
// { id, game, endedAt, players, options, over, snapshot }. Lines are
// appended, and only taken out by `delete`, which rewrites the file. What is
// kept in memory is an index: everything but the snapshot, plus where the
// line is in the file and a small preview of how it ended.

import path from 'node:path';
import { mkdir, readFile, appendFile, open, writeFile, rename } from 'node:fs/promises';

const NEWLINE = 10;
const PAGE_SIZE = 50;

export class Archive {
  // Without a directory nothing is written and the matches last as long as
  // the process, which is what tests want. `preview(game, snapshot)` returns
  // what lists show of a match, or null.
  constructor({ dir = null, preview = () => null } = {}) {
    this.dir = dir;
    this.preview = preview;
    this.byId = new Map(); // match id -> index entry
    this.byGame = new Map(); // game id -> index entries, oldest first
    this.sizes = new Map(); // game id -> bytes in its file, counting queued writes
    this.writing = Promise.resolve();
  }

  file(game) {
    return path.join(this.dir, `${game}.jsonl`);
  }

  // Reads what earlier runs of the server saved for these games.
  async load(gameIds) {
    if (!this.dir) return;
    await mkdir(this.dir, { recursive: true });
    for (const game of gameIds) {
      let data;
      try {
        data = await readFile(this.file(game));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        continue;
      }
      let offset = 0;
      while (offset < data.length) {
        let end = data.indexOf(NEWLINE, offset);
        if (end === -1) end = data.length;
        try {
          if (end > offset) this.remember(JSON.parse(data.subarray(offset, end)), { offset, length: end - offset });
        } catch {
          console.warn(`Skipping an unreadable line at byte ${offset} of ${this.file(game)}`);
        }
        offset = end + 1;
      }
      // A last line cut short by a crash must not run into the next one.
      if (data.length && data[data.length - 1] !== NEWLINE) {
        await appendFile(this.file(game), '\n');
        this.sizes.set(game, data.length + 1);
      } else this.sizes.set(game, data.length);
    }
  }

  remember(record, where) {
    const { id, game, endedAt, players, options, over } = record;
    const list = this.byGame.get(game) || [];
    this.byGame.set(game, list);
    // `seq` counts a game's matches from the oldest; lists are paged by it.
    // The preview is worked out from the snapshot each time, so matches saved
    // before a game changed its preview still get the current kind.
    const preview = this.preview(game, record.snapshot);
    const entry = { id, game, endedAt, players, options, over, preview, seq: list.length, ...where };
    list.push(entry);
    this.byId.set(id, entry);
  }

  // Adds a finished match. It is listed at once; the file follows.
  save(record) {
    if (!this.dir) {
      this.remember(record, { snapshot: record.snapshot });
      return;
    }
    const line = Buffer.from(`${JSON.stringify(record)}\n`);
    const offset = this.sizes.get(record.game) || 0;
    this.sizes.set(record.game, offset + line.length);
    this.remember(record, { offset, length: line.length - 1 });
    this.writing = this.writing
      .then(() => appendFile(this.file(record.game), line))
      .catch((err) => console.error(`Could not save match ${record.id}:`, err));
  }

  // Takes a match out for good: from the lists at once, and from its file in
  // turn with the writes before it. The file is written afresh beside the
  // old one and then put in its place, so a crash leaves one or the other
  // whole. Resolves to false if there is no such match.
  async delete(id) {
    const entry = this.byId.get(id);
    if (!entry) return false;
    const list = this.byGame.get(entry.game);
    list.splice(list.indexOf(entry), 1);
    this.byId.delete(id);
    list.forEach((e, i) => {
      e.seq = i;
    });
    if (!this.dir) return true;
    // Where each remaining line is now, and where it will be: worked out at
    // once, so that a match saved meanwhile is put after the new end.
    const moves = list.map((e) => ({ entry: e, from: e.offset }));
    let size = 0;
    for (const e of list) {
      e.offset = size;
      size += e.length + 1;
    }
    this.sizes.set(entry.game, size);
    const file = this.file(entry.game);
    this.writing = this.writing.then(async () => {
      const data = await readFile(file);
      const kept = Buffer.concat(moves.flatMap(({ entry: e, from }) => [data.subarray(from, from + e.length), Buffer.from('\n')]));
      await writeFile(`${file}.tmp`, kept);
      await rename(`${file}.tmp`, file);
    }).catch((err) => console.error(`Could not delete match ${id}:`, err));
    await this.writing;
    return true;
  }

  // The matches of one game, newest first, without their snapshots. `before`
  // is the `seq` of the last match already shown and `player` keeps only the
  // matches that name took part in.
  list(game, { before, player, limit = PAGE_SIZE } = {}) {
    const all = this.byGame.get(game) || [];
    const name = typeof player === 'string' ? player.toLowerCase() : null;
    const games = [];
    let more = false;
    for (let i = Math.min(all.length, before ?? Infinity) - 1; i >= 0; i--) {
      const m = all[i];
      if (name !== null && !m.players.some((p) => p.toLowerCase() === name)) continue;
      if (games.length === limit) {
        more = true;
        break;
      }
      const { id, endedAt, players, options, over, preview, seq } = m;
      games.push({ id, endedAt, players, options, over, preview, seq });
    }
    return { games, more };
  }

  // The whole record of one match, or null.
  async get(id) {
    const entry = this.byId.get(id);
    if (!entry) return null;
    if (!this.dir) return entry;
    await this.writing;
    const file = await open(this.file(entry.game), 'r');
    try {
      const { buffer } = await file.read(Buffer.alloc(entry.length), 0, entry.length, entry.offset);
      return JSON.parse(buffer);
    } catch {
      return null;
    } finally {
      await file.close();
    }
  }
}

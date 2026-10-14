// Feedback the players send, for the admin panel, and the limits that keep
// it from being flooded.
//
// Messages are kept in <dir>/feedback.jsonl, one per line:
// { id, at, name, kind, text, game, read }. Marking one read or deleting it
// writes the file afresh (it stays small). Without a directory they last
// as long as the process. Senders' addresses are only counted, in memory,
// for the limits; they are never kept.

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, appendFile, rename, mkdir } from 'node:fs/promises';

export const KINDS = { bug: 'Bug', idea: 'Idea', other: 'Other' };
export const MAX_LENGTH = 1000;
const MIN_LENGTH = 3;
const DAY_MS = 24 * 60 * 60_000;

export class FeedbackBox {
  // The limits: per name, a message at most every `gapMs` and `perName` a
  // day; per address `perAddress` a day; and `perDay` a day from everyone.
  constructor({
    dir = null, now = Date.now, gapMs = 60_000, perName = 5, perAddress = 10, perDay = 200,
  } = {}) {
    Object.assign(this, { dir, now, gapMs, perName, perAddress, perDay });
    this.messages = []; // oldest first
    this.sent = []; // { at, name, address } of the last day's messages
    this.writing = Promise.resolve();
  }

  file() {
    return path.join(this.dir, 'feedback.jsonl');
  }

  async load() {
    if (!this.dir) return;
    await mkdir(this.dir, { recursive: true });
    let text = '';
    try {
      text = await readFile(this.file(), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.messages.push(JSON.parse(line));
      } catch {
        console.warn('Skipping an unreadable line of feedback.jsonl');
      }
    }
  }

  // How long `name` must wait before sending again, in ms (0 if it may).
  waitFor(name) {
    const key = name.toLowerCase();
    const last = this.sent.filter((s) => s.name === key).pop();
    return last ? Math.max(0, last.at + this.gapMs - this.now()) : 0;
  }

  // Takes a message from `name` at `address`. Returns { message } or
  // { error, retryAfterMs? }.
  add({ name, address, kind, text, game }) {
    const now = this.now();
    this.sent = this.sent.filter((s) => s.at > now - DAY_MS);
    const key = name.toLowerCase();
    const clean = typeof text === 'string' ? text.trim().replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n') : '';
    if (clean.length < MIN_LENGTH) return { error: 'Write a few words first.' };
    if (clean.length > MAX_LENGTH) return { error: `Keep it to ${MAX_LENGTH} characters.` };
    if (!Object.hasOwn(KINDS, kind)) return { error: 'Choose what kind of feedback it is.' };
    const wait = this.waitFor(name);
    if (wait) return { error: 'Thanks! Please wait a minute before sending more.', retryAfterMs: wait };
    const mine = this.sent.filter((s) => s.name === key);
    if (mine.length >= this.perName || this.sent.filter((s) => s.address === address).length >= this.perAddress) {
      return { error: 'Thanks for all your feedback today! You can send more tomorrow.' };
    }
    if (this.sent.length >= this.perDay) return { error: 'Feedback is full for today. Please try again tomorrow.' };
    const previous = this.messages.filter((m) => m.name.toLowerCase() === key).pop();
    if (previous && previous.text === clean) return { error: 'You have sent this already. Thanks!' };

    const message = {
      id: randomUUID(),
      at: now,
      name,
      kind,
      text: clean,
      game: typeof game === 'string' && /^[\w-]{1,40}$/.test(game) ? game : null,
      read: false,
    };
    this.messages.push(message);
    this.sent.push({ at: now, name: key, address });
    if (this.dir) {
      const line = `${JSON.stringify(message)}\n`;
      this.writing = this.writing.then(() => appendFile(this.file(), line))
        .catch((err) => console.error('Could not save feedback:', err));
    }
    return { message };
  }

  // Newest first; only unread ones with `unread`.
  list({ unread = false } = {}) {
    return this.messages.filter((m) => !unread || !m.read).slice().reverse();
  }

  unread() {
    return this.messages.filter((m) => !m.read).length;
  }

  async markRead(id, read) {
    const message = this.messages.find((m) => m.id === id);
    if (!message) return false;
    message.read = Boolean(read);
    await this.rewrite();
    return true;
  }

  async delete(id) {
    const i = this.messages.findIndex((m) => m.id === id);
    if (i === -1) return false;
    this.messages.splice(i, 1);
    await this.rewrite();
    return true;
  }

  // Writes the file afresh beside the old one and puts it in its place, in
  // turn with the messages being added.
  async rewrite() {
    if (!this.dir) return;
    const text = this.messages.map((m) => `${JSON.stringify(m)}\n`).join('');
    this.writing = this.writing.then(async () => {
      await writeFile(`${this.file()}.tmp`, text);
      await rename(`${this.file()}.tmp`, this.file());
    }).catch((err) => console.error('Could not save feedback:', err));
    await this.writing;
  }
}

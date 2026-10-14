// What keeps the admin panel to its admin: the password, kept only as a
// scrypt hash; sessions once logged in; and a guard that makes guessing the
// password slower with every wrong guess.

import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const scrypt = (password, salt, length, options) => new Promise((resolve, reject) => {
  scryptCallback(password, salt, length, options, (err, key) => (err ? reject(err) : resolve(key)));
});

// Costly enough to slow guessing from a stolen hash (about a tenth of a
// second each), cheap enough for the odd login.
const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 32;
const maxmem = (N, r) => 256 * N * r;

// "scrypt$<N>$<r>$<p>$<salt>$<hash>", salt and hash in base64.
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p } = COST;
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: maxmem(N, r) });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).trim().split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const options = { N: Number(N), r: Number(r), p: Number(p), maxmem: maxmem(Number(N), Number(r)) };
  try {
    const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, options);
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// The stored hash, or null when no password has been set.
export async function readPasswordHash(file) {
  if (!file) return null;
  try {
    const text = (await readFile(file, 'utf8')).trim();
    return text.startsWith('scrypt$') ? text : null;
  } catch {
    return null;
  }
}

// Slows down guessing. Each address gets a few tries; after that every
// wrong password doubles how long it must wait, up to an hour. Across all
// addresses together, too many wrong passwords in ten minutes make everyone
// wait, so that guessing from many addresses at once gains little.
export class LoginGuard {
  constructor({
    now = Date.now, freeTries = 3, maxWaitMs = 60 * 60_000, globalLimit = 30, globalWindowMs = 10 * 60_000,
  } = {}) {
    Object.assign(this, { now, freeTries, maxWaitMs, globalLimit, globalWindowMs });
    this.byAddress = new Map(); // address -> { failures, until, last }
    this.recent = []; // times of the latest wrong passwords from anywhere
  }

  // How long `address` must wait before it may try, in ms; 0 if it may now.
  waitFor(address) {
    const now = this.now();
    this.recent = this.recent.filter((t) => t > now - this.globalWindowMs);
    const own = Math.max(0, (this.byAddress.get(address)?.until ?? 0) - now);
    const everyone = this.recent.length >= this.globalLimit ? this.recent[0] + this.globalWindowMs - now : 0;
    return Math.max(own, everyone);
  }

  failed(address) {
    const now = this.now();
    this.forgetOld(now);
    const entry = this.byAddress.get(address) ?? { failures: 0, until: 0 };
    entry.failures++;
    entry.last = now;
    const over = entry.failures - this.freeTries;
    entry.until = over > 0 ? now + Math.min(this.maxWaitMs, 1000 * 2 ** (over - 1)) : 0;
    this.byAddress.set(address, entry);
    this.recent.push(now);
  }

  succeeded(address) {
    this.byAddress.delete(address);
  }

  // An address quiet for a day starts afresh.
  forgetOld(now) {
    for (const [address, entry] of this.byAddress) {
      if (entry.last < now - 24 * 60 * 60_000) this.byAddress.delete(address);
    }
  }
}

// Who is logged in. A session ends after `idleMs` without use, after
// `maxMs` in any case, and as soon as the password changes: each one
// remembers the hash it was opened with.
export class Sessions {
  constructor({ now = Date.now, idleMs = 2 * 60 * 60_000, maxMs = 12 * 60 * 60_000 } = {}) {
    Object.assign(this, { now, idleMs, maxMs });
    this.byId = new Map();
  }

  create(passwordHash) {
    const id = randomBytes(32).toString('base64url');
    const now = this.now();
    this.byId.set(id, { passwordHash, created: now, used: now });
    return id;
  }

  // The session for `id` if it is still good, refreshed; else null.
  check(id, passwordHash) {
    const session = typeof id === 'string' ? this.byId.get(id) : undefined;
    if (!session) return null;
    const now = this.now();
    if (session.passwordHash !== passwordHash || now - session.used > this.idleMs || now - session.created > this.maxMs) {
      this.byId.delete(id);
      return null;
    }
    session.used = now;
    return session;
  }

  end(id) {
    this.byId.delete(id);
  }
}

// `node server/auth.js hash` reads a password from stdin and prints its
// hash; deploy/game-room set-password uses it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === 'hash') {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const password = input.replace(/\r?\n$/, '');
  if (password.length < 10) {
    console.error('Use at least 10 characters.');
    process.exit(1);
  }
  console.log(await hashPassword(password));
}

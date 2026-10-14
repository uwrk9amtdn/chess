// The admin panel's requests (/admin/api/...). The page itself is
// public/admin/; everything it shows or does comes from here, and only to
// someone logged in with the admin password.
//
// Logging in is only allowed over HTTPS, as the HTTPS proxy in front of the
// server reports it, or from the server itself (an SSH tunnel, say), so the
// password never crosses the network in the clear. The proxy's word on the
// visitor's address (X-Real-IP, else X-Forwarded-For) and protocol
// (X-Forwarded-Proto) is only taken from the addresses the proxy connects
// from (`proxies`, the server itself unless told otherwise); anyone else
// sending those headers gains nothing. A proxy that serves nothing but HTTPS
// and does not say so in X-Forwarded-Proto can be vouched for with
// `proxyHttps`. Wrong passwords are slowed down by a LoginGuard (auth.js).
//
// A session is a random id in a cookie the page's scripts cannot read
// (HttpOnly), sent only over HTTPS (Secure) and never with requests from
// other sites (SameSite=Strict). Requests that change something must also
// be JSON from the panel's own origin, which a form on another site cannot
// send.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyPassword, readPasswordHash, LoginGuard, Sessions } from './auth.js';

const COOKIE = 'game_room_admin';
const SESSION_HOURS = 12;
const MAX_BODY = 10_000;
const LOG_LINES = 30;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function cookieOf(req) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return null;
}

// An IPv4 address the way Node may write it, "::ffff:1.2.3.4", made plain.
const plain = (address) => String(address ?? '').replace(/^::ffff:(?=\d+\.)/, '');

// Where a request comes from, and whether it came over HTTPS.
function origin(req, { proxies, proxyHttps }) {
  const remote = plain(req.socket.remoteAddress);
  const realIp = req.headers['x-real-ip'];
  const forwarded = req.headers['x-forwarded-for'];
  if (proxies.has(remote) && (realIp || forwarded)) {
    // The proxy adds the address it saw at the end of X-Forwarded-For.
    const address = plain(realIp ? String(realIp).trim() : String(forwarded).split(',').pop().trim());
    const proto = req.headers['x-forwarded-proto'];
    return { address, https: proto ? proto === 'https' : proxyHttps, viaProxy: true, local: false };
  }
  return { address: remote, https: false, viaProxy: false, local: LOOPBACK.has(remote) };
}

// What the server sees of a request, to help set up the proxy settings.
const seen = (req, from) => ({
  connectionFrom: plain(req.socket.remoteAddress),
  xRealIp: req.headers['x-real-ip'] ?? null,
  xForwardedFor: req.headers['x-forwarded-for'] ?? null,
  xForwardedProto: req.headers['x-forwarded-proto'] ?? null,
  takenAs: { address: from.address, https: from.https || from.local, throughProxy: from.viaProxy },
});

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// The last lines of a log file, or none.
async function tail(file, lines) {
  try {
    return (await readFile(file, 'utf8')).trimEnd().split('\n').slice(-lines);
  } catch {
    return [];
  }
}

// `passwordFile` holds the admin password's hash (set with
// `deploy/game-room set-password`); without one nobody can log in.
// `stateDir` and `updateScript` are deploy/game-room's folder and the
// script itself, when the server runs under it: they give the update log
// and the update buttons. `version` describes the code running. `proxies`
// and `proxyHttps` describe the HTTPS proxy in front, as above.
export function createPanel({
  lobby, archive, stats, passwordFile = null, stateDir = null, updateScript = null, version = null,
  proxies = [...LOOPBACK], proxyHttps = false,
  now = Date.now, guard = new LoginGuard({ now }), sessions = new Sessions({ now }),
}) {
  const startedAt = now();
  const proxy = { proxies: new Set(proxies.map(plain)), proxyHttps };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    res.end(JSON.stringify(body));
  };

  // Why nobody can log in yet: the server was not told where the password
  // is kept (started by an older deploy/game-room), or none has been set.
  const noPassword = () => (passwordFile
    ? 'No admin password is set yet. Set one on the server with: deploy/game-room set-password'
    : 'The server was not told where the admin password is kept. Restart it with: deploy/game-room restart');

  const log = (text, from) => console.log(`${new Date(now()).toISOString()} admin: ${text} (${from.address})`);

  // Requests that change something must be JSON sent from the panel itself.
  function sameSite(req) {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return false;
    const from = req.headers.origin;
    if (!from) return true;
    try {
      return new URL(from).host === req.headers.host;
    } catch {
      return false;
    }
  }

  async function login(req, res, from) {
    const hash = await readPasswordHash(passwordFile);
    if (!hash) return send(res, 409, { error: noPassword() });
    if (!from.https && !from.local) return send(res, 403, { error: 'Log in over HTTPS.' });
    const wait = guard.waitFor(from.address);
    if (wait) return send(res, 429, { error: 'Too many wrong passwords.', retryAfterMs: wait }, { 'Retry-After': String(Math.ceil(wait / 1000)) });
    let password;
    try {
      ({ password } = await readBody(req));
    } catch {
      return send(res, 400, { error: 'Bad request.' });
    }
    if (typeof password !== 'string' || !password || !(await verifyPassword(password, hash))) {
      guard.failed(from.address);
      log('wrong password', from);
      return send(res, 401, { error: 'Wrong password.', retryAfterMs: guard.waitFor(from.address) });
    }
    guard.succeeded(from.address);
    log('logged in', from);
    const id = sessions.create(hash);
    // Secure is left off only for a browser on the server itself, which may
    // use plain http://localhost.
    const secure = from.local ? '' : ' Secure;';
    send(res, 200, { ok: true }, {
      'Set-Cookie': `${COOKIE}=${id}; Path=/admin; HttpOnly;${secure} SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`,
    });
  }

  // The live state: who is on, what is played, how the server is doing.
  async function overview() {
    const memory = process.memoryUsage();
    const { players, matches } = lobby.overview();
    // The commits deploy/game-room leaves alone: tests failed, or called off.
    const marker = async (name) => {
      if (!stateDir) return null;
      try {
        return (await readFile(path.join(stateDir, name), 'utf8')).trim().slice(0, 7) || null;
      } catch {
        return null;
      }
    };
    return {
      now: now(),
      startedAt,
      version,
      // Every game, in a fixed order, so that each keeps its colour.
      games: [...lobby.games.values()].map((g) => ({ id: g.meta.id, name: g.meta.name })),
      memoryMb: Math.round(memory.rss / 2 ** 20),
      heapMb: Math.round(memory.heapUsed / 2 ** 20),
      players,
      matches,
      restart: lobby.restartStatus(),
      updates: {
        available: Boolean(updateScript),
        failedCommit: await marker('update-failed'),
        skippedCommit: await marker('update-skipped'),
        log: stateDir ? await tail(path.join(stateDir, 'update.log'), LOG_LINES) : [],
      },
    };
  }

  // Runs deploy/game-room on its own, so that it lives on when it restarts
  // the server.
  function runScript(command) {
    const child = spawn(updateScript, [command], { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error('Could not run the update script:', err));
    child.unref();
  }

  async function act(req, res, from, pathname) {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: 'Bad request.' });
    }
    if (pathname === '/admin/api/records/delete') {
      const done = typeof body.id === 'string' && await archive.delete(body.id);
      if (!done) return send(res, 404, { error: 'No such game.' });
      log(`deleted game ${body.id}`, from);
      return send(res, 200, { ok: true });
    }
    if (pathname === '/admin/api/update') {
      const { action } = body;
      if (action === 'cancel') {
        lobby.cancelRestart();
        log('called off the update', from);
        return send(res, 200, { ok: true });
      }
      if (!updateScript) return send(res, 409, { error: 'The server does not run under deploy/game-room.' });
      if (action !== 'check' && action !== 'now') return send(res, 400, { error: 'Unknown action.' });
      runScript(action === 'check' ? 'check' : 'update-now');
      log(action === 'check' ? 'asked for an update check' : 'asked to update now', from);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'Not found.' });
  }

  // Handles a request under /admin/api/.
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const from = origin(req, proxy);
    const hash = await readPasswordHash(passwordFile);
    const id = cookieOf(req);
    const session = hash ? sessions.check(id, hash) : null;
    // Over plain HTTP from outside, the panel has nothing to say.
    const allowed = from.https || from.local;

    if (url.pathname === '/admin/api/session' && req.method === 'GET') {
      return send(res, 200, {
        loggedIn: Boolean(session),
        passwordSet: Boolean(hash),
        ...(hash ? {} : { noPassword: noPassword() }),
        https: allowed,
        retryAfterMs: guard.waitFor(from.address),
        seen: seen(req, from),
      });
    }
    if (url.pathname === '/admin/api/login' && req.method === 'POST') {
      if (!sameSite(req)) return send(res, 403, { error: 'Bad request.' });
      return login(req, res, from);
    }
    if (url.pathname === '/admin/api/logout' && req.method === 'POST') {
      if (id) sessions.end(id);
      return send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    if (!session || !allowed) return send(res, 401, { error: 'Log in first.' });

    if (req.method === 'GET') {
      if (url.pathname === '/admin/api/overview') return send(res, 200, await overview());
      if (url.pathname === '/admin/api/stats') {
        const days = Math.min(3660, Math.max(1, Number(url.searchParams.get('days')) || 30));
        return send(res, 200, { days: stats.days(days), hours: stats.lastHours() });
      }
      if (url.pathname === '/admin/api/records') {
        const game = url.searchParams.get('game');
        const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
        const player = url.searchParams.get('player') || undefined;
        return send(res, 200, archive.list(game, { before, player, limit: 25 }));
      }
      return send(res, 404, { error: 'Not found.' });
    }
    if (req.method === 'POST') {
      if (!sameSite(req)) return send(res, 403, { error: 'Bad request.' });
      return act(req, res, from, url.pathname);
    }
    send(res, 405, { error: 'Not allowed.' });
  };
}

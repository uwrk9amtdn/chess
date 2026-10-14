// HTTP server for the site shell and each game's browser code, plus the
// WebSocket endpoint for the lobby, the admin panel (/admin, see panel.js),
// and a small interface for the script that updates the server
// (deploy/game-room).

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Lobby } from './lobby.js';
import { loadGames } from './games.js';
import { Archive } from './archive.js';
import { Stats } from './stats.js';
import { createPanel } from './panel.js';
import { FeedbackBox } from './feedback.js';
import { origin, proxySettings } from './proxy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(root, 'public');
const GAMES = path.join(root, 'games');
const DATA = path.join(root, 'data');
// The parts of a game folder a browser may fetch. Server code stays private.
const GAME_FILE = /^\/games\/([^/]+)\/(?:(meta\.js)|(client|shared)\/(.+))$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// Maps a URL path to [directory it must stay inside, path within it].
function locate(pathname, games, gamesDir) {
  if (pathname === '/admin' || pathname === '/admin/') return [PUBLIC, 'admin/index.html'];
  if (!pathname.startsWith('/games/')) return [PUBLIC, pathname === '/' ? 'index.html' : pathname.slice(1)];
  const [, id, meta, folder, rest] = GAME_FILE.exec(pathname) || [];
  if (!games.has(id)) return null;
  return meta ? [path.join(gamesDir, id), meta] : [path.join(gamesDir, id, folder), rest];
}

async function serveStatic(req, res, games, gamesDir) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const located = locate(pathname, games, gamesDir);
  const file = located && path.join(...located);
  if (!file || !file.startsWith(located[0] + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    // The admin page may not be shown inside another site's page, nor be
    // listed by search engines.
    const adminPage = file.startsWith(path.join(PUBLIC, 'admin') + path.sep) ? {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
    } : {};
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...adminPage,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// The interface for the update script on the same machine. Every
// request must carry the token the server was started with
// ("Authorization: Bearer <token>"); without a token there is no admin
// interface, and a wrong one gets the same "Not found" as any unknown path.
//
//   GET    /admin/status            { restart, games, players }
//   POST   /admin/restart?in=<s>    announce a restart in s seconds (or
//                                   sooner, if one is announced already)
//   DELETE /admin/restart           call it off
//
// `restart` is null, or { msLeft, games, ready }: the restart may happen
// once `ready`, when the time is up and no match is being played.
function admin(req, res, lobby, token) {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const given = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const status = () => ({ restart: lobby.restartStatus(), games: lobby.matches.size, players: lobby.users.size });
  if (url.pathname === '/admin/status' && req.method === 'GET') return send(200, status());
  if (url.pathname === '/admin/restart' && req.method === 'POST') {
    const seconds = Number(url.searchParams.get('in') ?? 300);
    if (!(seconds >= 0)) return send(400, { error: 'in must be a number of seconds' });
    lobby.scheduleRestart(seconds * 1000);
    return send(200, status());
  }
  if (url.pathname === '/admin/restart' && req.method === 'DELETE') {
    lobby.cancelRestart();
    return send(200, status());
  }
  send(404, { error: 'unknown admin request' });
}

// The commit running, as "<short hash> <date> <subject>", or null where
// that cannot be found out.
function currentVersion() {
  return new Promise((resolve) => {
    execFile('git', ['log', '-1', '--format=%h %cs %s'], { cwd: root, timeout: 3000 }, (err, out) => {
      resolve(err ? null : out.trim() || null);
    });
  });
}

// Finished matches and statistics are saved in `dataDir`; without one they
// are only kept until the server stops. `adminToken` turns on the
// interface for the update script; `passwordFile` (the admin password's
// hash), `stateDir` and `updateScript` are for the admin panel, see
// panel.js. Remaining options go to the Lobby. Port 0 picks a free port.
export async function startServer({
  port = 9494, gamesDir = GAMES, dataDir = null, adminToken = null,
  passwordFile = null, stateDir = null, updateScript = null, panelOptions = {}, feedbackOptions = {}, ...lobbyOptions
} = {}) {
  const games = await loadGames(gamesDir);
  const archive = new Archive({
    dir: dataDir,
    preview: (game, snapshot) => games.get(game)?.preview?.(snapshot) ?? null,
  });
  await archive.load([...games.keys()]);
  const version = await currentVersion();
  const stats = new Stats({ dir: dataDir, version });
  await stats.load();
  stats.start();
  const feedback = new FeedbackBox({ dir: dataDir, ...feedbackOptions });
  await feedback.load();
  const lobby = new Lobby({ games, archive, stats, feedback, ...lobbyOptions });
  const panel = createPanel({
    lobby, archive, stats, feedback, passwordFile, stateDir, updateScript, version, ...panelOptions,
  });
  const proxy = proxySettings(panelOptions);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/admin/api/')) {
      panel(req, res).catch((err) => {
        console.error('Error in the admin panel:', err);
        stats.error();
        if (!res.headersSent) res.writeHead(500).end();
      });
    } else if (req.url.startsWith('/admin/status') || req.url.startsWith('/admin/restart')) {
      admin(req, res, lobby, adminToken);
    } else serveStatic(req, res, games, gamesDir);
  });
  const wss = new WebSocketServer({ server, maxPayload: 4096 });
  wss.on('connection', (ws, req) => lobby.connect(ws, origin(req, proxy).address));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve({
        port: server.address().port,
        close() {
          for (const ws of wss.clients) ws.terminate();
          server.close();
          stats.stop();
        },
        // Resolves once every finished match and the statistics are on disk.
        saved: () => Promise.all([archive.writing, feedback.writing, stats.save()]),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startServer({
    port: Number(process.env.PORT) || 9494,
    dataDir: process.env.DATA_DIR || DATA,
    adminToken: process.env.ADMIN_TOKEN || null,
    // Set by deploy/game-room; see DEPLOY.md.
    passwordFile: process.env.ADMIN_PASSWORD_FILE || null,
    stateDir: process.env.GAME_ROOM_STATE || null,
    updateScript: process.env.GAME_ROOM_SCRIPT || null,
    panelOptions: {
      // The HTTPS proxy in front: where it connects from, and whether it
      // serves only HTTPS (see panel.js and DEPLOY.md).
      ...(process.env.PROXY_ADDRESSES ? { proxies: process.env.PROXY_ADDRESSES.split(/[\s,]+/).filter(Boolean) } : {}),
      proxyHttps: process.env.PROXY_HTTPS === 'yes',
    },
  });
  console.log(`Game server running at http://localhost:${server.port}`);
  // Stopped (by deploy/game-room, say): finish writing what was saved first.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      server.close();
      await server.saved();
      process.exit(0);
    });
  }
}

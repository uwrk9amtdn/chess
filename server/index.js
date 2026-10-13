// HTTP server for the site shell and each game's browser code, plus the
// WebSocket endpoint for the lobby.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Lobby } from './lobby.js';
import { loadGames } from './games.js';
import { Archive } from './archive.js';

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
};

// Maps a URL path to [directory it must stay inside, path within it].
function locate(pathname, games, gamesDir) {
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
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// Finished matches are saved in `dataDir`; without one they are only kept
// until the server stops. Remaining options go to the Lobby. Port 0 picks a
// free port.
export async function startServer({ port = 9494, gamesDir = GAMES, dataDir = null, ...lobbyOptions } = {}) {
  const games = await loadGames(gamesDir);
  const archive = new Archive({
    dir: dataDir,
    preview: (game, snapshot) => games.get(game)?.preview?.(snapshot) ?? null,
  });
  await archive.load([...games.keys()]);
  const lobby = new Lobby({ games, archive, ...lobbyOptions });
  const server = http.createServer((req, res) => serveStatic(req, res, games, gamesDir));
  const wss = new WebSocketServer({ server, maxPayload: 4096 });
  wss.on('connection', (ws) => lobby.connect(ws));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve({
        port: server.address().port,
        close() {
          for (const ws of wss.clients) ws.terminate();
          server.close();
        },
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startServer({ port: Number(process.env.PORT) || 9494, dataDir: process.env.DATA_DIR || DATA });
  console.log(`Game server running at http://localhost:${port}`);
}

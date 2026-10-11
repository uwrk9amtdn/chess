// HTTP server for the static client plus the WebSocket endpoint for the lobby.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Lobby } from './lobby.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(root, 'public');
const SHARED = path.join(root, 'shared');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  // shared/ holds the rules engine, which the browser imports as-is.
  const [base, rel] = pathname.startsWith('/shared/')
    ? [SHARED, pathname.slice('/shared/'.length)]
    : [PUBLIC, pathname === '/' ? 'index.html' : pathname.slice(1)];
  const file = path.join(base, rel);
  if (!file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
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

// Remaining options go to the Lobby. Port 0 picks a free port.
export function startServer({ port = 9494, ...lobbyOptions } = {}) {
  const lobby = new Lobby(lobbyOptions);
  const server = http.createServer(serveStatic);
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
  const { port } = await startServer({ port: Number(process.env.PORT) || 9494 });
  console.log(`Chess server running at http://localhost:${port}`);
}

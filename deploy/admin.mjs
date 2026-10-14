// Talks to the running server's admin interface (see server/index.js) for
// deploy/game-room:
//
//   node admin.mjs <port> <token file> status
//   node admin.mjs <port> <token file> announce <seconds>
//   node admin.mjs <port> <token file> cancel
//
// Prints where a restart stands, as one line: "none" (nothing announced),
// "waiting <seconds left> <games in progress>" or "ready". Exits with 1 if
// the server cannot be reached or does not accept the token.

import { readFile } from 'node:fs/promises';

const [port, tokenFile, command, seconds] = process.argv.slice(2);
const requests = {
  status: ['GET', '/admin/status'],
  announce: ['POST', `/admin/restart?in=${Number(seconds)}`],
  cancel: ['DELETE', '/admin/restart'],
};

try {
  const [method, path] = requests[command];
  const token = (await readFile(tokenFile, 'utf8')).trim();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { restart } = await res.json();
  if (!restart) console.log('none');
  else if (restart.ready) console.log('ready');
  else console.log(`waiting ${Math.ceil(restart.msLeft / 1000)} ${restart.games}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

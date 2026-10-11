import WebSocket from 'ws';

// A WebSocket client that lets a test wait for the next message it cares about.
export function connect(port) {
  const ws = new WebSocket(`ws://localhost:${port}`);
  const queue = [];
  let waiter = null;
  const pump = () => {
    if (!waiter) return;
    const i = queue.findIndex(waiter.match);
    if (i === -1) return;
    const [msg] = queue.splice(0, i + 1).slice(-1);
    clearTimeout(waiter.timer);
    const { resolve } = waiter;
    waiter = null;
    resolve(msg);
  };
  ws.on('message', (raw) => {
    queue.push(JSON.parse(raw));
    pump();
  });
  return {
    opened: new Promise((resolve) => ws.once('open', resolve)),
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    // Resolves with the first message of `type` that satisfies `where`,
    // discarding everything queued before it.
    next(type, where = () => true) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), 3000);
        waiter = { match: (m) => m.type === type && where(m), resolve, timer };
        pump();
      });
    },
  };
}

// { name: status } from a "users" message.
export const statuses = (msg) => Object.fromEntries(msg.users.map((u) => [u.name, u.status]));

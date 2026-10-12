// The site shell: connection, user name, the shared player list, invitations,
// the grid of games and the page that hosts whichever game is being played.
// It knows nothing about any particular game; each one is loaded from
// /games/<id>/client/index.js and driven through the contract in
// games/README.md.

import { play, isMuted, setMuted } from './sounds.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'games.session';
const RECONNECT_MS = 1000;
const TOAST_MS = 4000;

let ws = null;
let me = null;
let users = [];
let games = new Map(); // id -> meta, as sent by the server
const clients = new Map(); // id -> the game's browser module
let route = null; // id of the game page that is open, or null for the grid
let match = null; // { game, snapshot }: the match being played or just finished
let mounted = null; // { game, view }: the game screen currently on the page
let resuming = false; // the next match message continues an old match
let outgoing = null; // the invitation we sent, if any
let chat = { id: null, messages: [] }; // what was said in the match with that id
const incoming = new Map(); // id -> invitation

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function toast(text) {
  const node = el('div', { className: 'toast', textContent: text });
  $('toasts').append(node);
  setTimeout(() => node.remove(), TOAST_MS);
}

// The name and token live for this tab only, so a reload returns to the same
// seat while a second tab can be a second player.
function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage can be unavailable; the only loss is the automatic rejoin.
  }
}

const playing = () => Boolean(match && !match.snapshot.over);

// ---- connection ----

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  // Messages are handled strictly in order, even though the first one waits
  // for the games' code to load.
  let queue = Promise.resolve();
  ws.onopen = () => {
    $('offline').hidden = true;
    const session = loadSession();
    if (session) send({ type: 'join', ...session });
    else showNameDialog();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (handlers[msg.type]) queue = queue.then(() => handlers[msg.type](msg)).catch(console.error);
  };
  ws.onclose = () => {
    $('offline').hidden = false;
    setTimeout(connect, RECONNECT_MS);
  };
}

const INVITE_CLOSED = {
  declined: 'declined your invitation',
  expired: 'did not answer',
  unavailable: 'is no longer available',
};

const handlers = {
  async joined(msg) {
    me = msg.name;
    saveSession({ name: msg.name, token: msg.token });
    $('nameDialog').close();
    $('me').textContent = `Signed in as ${me}`;
    games = new Map(msg.games.map((g) => [g.id, g]));
    await Promise.all(msg.games.map(async (g) => {
      if (!clients.has(g.id)) clients.set(g.id, (await import(`/games/${g.id}/client/index.js`)).default);
    }));
    // After a reconnect the server resends a match that is still running and
    // has dropped every invitation, so start from a clean slate.
    resuming = msg.resumed;
    if (playing()) closeMatch();
    outgoing = null;
    incoming.clear();
    applyRoute();
  },
  joinError(msg) {
    me = null;
    saveSession(null);
    showNameDialog(msg.message);
  },
  users(msg) {
    users = msg.users;
    render();
  },
  invite(msg) {
    incoming.set(msg.id, msg);
    play('notify');
    renderInvites();
  },
  inviteSent(msg) {
    outgoing = msg;
    render();
  },
  inviteClosed(msg) {
    if (outgoing && outgoing.id === msg.id) {
      if (INVITE_CLOSED[msg.reason]) toast(`${outgoing.to} ${INVITE_CLOSED[msg.reason]}.`);
      outgoing = null;
    }
    incoming.delete(msg.id);
    render();
  },
  match(msg) {
    const fresh = !match || match.snapshot.id !== msg.snapshot.id;
    if (fresh && !resuming && !msg.snapshot.over) play('start');
    resuming = false;
    match = { game: msg.game, snapshot: msg.snapshot };
    // A match takes over the page, wherever the player was.
    if (route !== msg.game) {
      route = msg.game;
      location.hash = `#/${msg.game}`;
    }
    if (mounted && mounted.game !== match.game) unmount();
    const opened = !mounted;
    if (opened) mounted = { game: match.game, view: clients.get(match.game).mount($('matchHost'), ctx) };
    mounted.view.update(match.snapshot);
    if (chat.id !== msg.snapshot.id) chat = { id: msg.snapshot.id, messages: [] };
    if (fresh || opened) showChat();
    render();
  },
  chat(msg) {
    if (chat.id !== msg.id) chat = { id: msg.id, messages: [] };
    chat.messages.push({ from: msg.from, text: msg.text });
    showChat();
  },
  // Everything said so far, sent when we come back to a match.
  chatLog(msg) {
    chat = { id: msg.id, messages: msg.messages };
    showChat();
  },
  error(msg) {
    toast(msg.message);
    // Lets the game undo anything it showed before the server refused it.
    if (mounted) mounted.view.update(match.snapshot);
  },
};

// Hands the conversation to the game on screen, if it shows one.
function showChat() {
  if (mounted && match && match.snapshot.id === chat.id) mounted.view.chat?.(chat.messages);
}

// What a game's screen gets from the platform.
const ctx = {
  send: (action) => send({ ...action, type: 'action' }),
  sendChat: (text) => send({ type: 'chat', text }),
  play,
  toast,
};

function unmount() {
  mounted.view.destroy();
  mounted = null;
}

function closeMatch() {
  match = null;
  if (mounted) unmount();
}

// ---- routing: "#/" is the grid, "#/<game id>" is that game's page ----

function applyRoute() {
  const id = location.hash.replace(/^#\/?/, '');
  const next = games.has(id) ? id : null;
  // A match in progress cannot be left by navigating; a finished one is put away.
  if (playing() && next !== match.game) {
    location.hash = `#/${match.game}`;
    return;
  }
  if (match && next !== match.game) closeMatch();
  route = next;
  render();
}
window.addEventListener('hashchange', applyRoute);

function render() {
  $('home').hidden = route !== null;
  $('gamePage').hidden = route === null;
  renderGrid();
  renderUsers();
  renderInvites();
  if (route === null) return;
  const meta = games.get(route);
  $('gameTitle').textContent = meta.name;
  $('gameDescription').textContent = meta.description;
  $('gameHint').hidden = Boolean(match);
  $('backLink').hidden = playing();
  // Offered once a match is over; assumes the two-player games the lobby seats today.
  const over = Boolean(match && match.snapshot.over);
  $('afterGame').hidden = !over;
  if (over) {
    const rival = opponent();
    const free = users.some((u) => u.name === rival && u.status === 'idle');
    $('rematch').disabled = !free || Boolean(outgoing);
  }
}

const opponent = () => match.snapshot.players.find((_, seat) => seat !== match.snapshot.you);

$('rematch').addEventListener('click', () => {
  send({ type: 'invite', to: opponent(), game: match.game, options: match.snapshot.options });
});
$('closeMatch').addEventListener('click', () => {
  closeMatch();
  render();
});

function renderGrid() {
  $('gameGrid').replaceChildren(...[...games.values()].map((g) => {
    const active = users.filter((u) => u.game === g.id).length;
    return el('a', { className: 'gameCard', href: `#/${g.id}` },
      el('span', { className: 'gameIcon', textContent: g.icon || g.name[0] }),
      el('strong', { textContent: g.name }),
      el('span', { className: 'gameAbout', textContent: g.description }),
      el('span', { className: 'gameMeta', textContent: `${g.players} players · ${active} playing now` }));
  }));
}

// ---- name ----

function showNameDialog(error = '') {
  $('nameError').textContent = error;
  if (!$('nameDialog').open) $('nameDialog').showModal();
  $('nameInput').focus();
}

$('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ type: 'join', name: $('nameInput').value });
});
// A name is required, so Escape must not dismiss the dialog.
$('nameDialog').addEventListener('cancel', (e) => e.preventDefault());

// ---- players and invitations ----

function renderUsers() {
  const sorted = [...users].sort((a, b) => (b.name === me) - (a.name === me) || a.name.localeCompare(b.name));
  $('userCount').textContent = users.length;
  $('users').replaceChildren(...sorted.map((u) => {
    let status = u.game && games.has(u.game) ? `${u.status} · ${games.get(u.game).name}` : u.status;
    if (u.name === me) status = `you · ${status}`;
    const li = el('li', {},
      el('span', { className: `dot ${u.status}` }),
      el('span', { className: 'userName', textContent: u.name }),
      el('span', { className: `userStatus ${u.status}`, textContent: status }));
    // Invitations are for the game whose page is open.
    if (route && u.name !== me && u.status === 'idle' && !playing() && !outgoing) {
      li.append(el('button', { textContent: 'Invite', onclick: () => openInvite(u.name) }));
    }
    return li;
  }));
}

function openInvite(name) {
  const game = route;
  $('inviteTitle').textContent = `Challenge ${name} to ${games.get(game).name}`;
  $('inviteForm').replaceChildren();
  clients.get(game).inviteForm($('inviteForm'), (options) => {
    send({ type: 'invite', to: name, game, options });
    $('inviteDialog').close();
  });
  $('inviteDialog').showModal();
}
$('inviteCancel').addEventListener('click', () => $('inviteDialog').close());

// "Chess (3+1)"
function describeInvite({ game, options }) {
  return `${games.get(game).name} (${clients.get(game).describeOptions(options)})`;
}

function renderInvites() {
  const cards = [];
  if (outgoing) {
    cards.push(el('div', { className: 'invite' },
      el('p', { textContent: `Waiting for ${outgoing.to}: ${describeInvite(outgoing)}…` }),
      el('button', { textContent: 'Cancel', onclick: () => send({ type: 'cancel', id: outgoing.id }) })));
  }
  for (const invite of incoming.values()) {
    cards.push(el('div', { className: 'invite' },
      el('p', {}, el('strong', { textContent: invite.from }), ` challenges you to ${describeInvite(invite)}.`),
      el('button', { className: 'primary', textContent: 'Accept', onclick: () => send({ type: 'accept', id: invite.id }) }),
      el('button', { textContent: 'Decline', onclick: () => send({ type: 'decline', id: invite.id }) })));
  }
  $('invites').replaceChildren(...cards);
}

// ---- sound ----

function renderSoundToggle() {
  $('soundToggle').textContent = isMuted() ? 'Sound: off' : 'Sound: on';
}
$('soundToggle').addEventListener('click', () => {
  setMuted(!isMuted());
  renderSoundToggle();
  play('move');
});
renderSoundToggle();

connect();

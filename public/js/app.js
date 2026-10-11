// Lobby, invitations and the game screen. All game state comes from the
// server as snapshots; this file only draws them and sends the player's intent.

import { variants } from '/shared/variants.js';
import { deserialize, seatToMove, teamOf, kingSquares } from '/shared/engine.js';
import { createBoard, glyph } from './board.js';
import { play, isMuted, setMuted } from './sounds.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'chess.session';
const RECONNECT_MS = 1000;
const TOAST_MS = 4000;
const LOW_TIME_MS = 10_000;

let ws = null;
let me = null;
let users = [];
let game = null; // latest snapshot from the server
let gameAt = 0; // performance.now() when it arrived, for ticking the clock
let outgoing = null; // the invitation we sent, if any
const incoming = new Map(); // id -> invitation
let lowTimeWarned = null; // id of the game we already beeped for

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

const formatTimeControl = (minutes, increment) => `${minutes}+${increment}`;

// "3+1" for standard chess, "3+1 Double 16x16" for anything else.
function describeInvite({ minutes, increment, variant }) {
  const time = formatTimeControl(minutes, increment);
  return variant === 'standard' ? time : `${time} ${variants[variant].name}`;
}

function formatClock(ms) {
  if (ms < LOW_TIME_MS) {
    const tenths = Math.floor(ms / 100);
    return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`;
  }
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// ---- connection ----

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => {
    $('offline').hidden = true;
    const session = loadSession();
    if (session) send({ type: 'join', ...session });
    else showNameDialog();
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (handlers[msg.type]) handlers[msg.type](msg);
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
  joined(msg) {
    me = msg.name;
    saveSession({ name: msg.name, token: msg.token });
    $('nameDialog').close();
    $('me').textContent = `Signed in as ${me}`;
    // After a reconnect the server resends a game that is still running and
    // has dropped every invitation, so start from a clean slate.
    if (game && !game.over) game = null;
    outgoing = null;
    incoming.clear();
    renderGame();
    renderInvites();
    renderUsers();
  },
  joinError(msg) {
    me = null;
    saveSession(null);
    showNameDialog(msg.message);
  },
  users(msg) {
    users = msg.users;
    renderUsers();
    renderActions();
  },
  invite(msg) {
    incoming.set(msg.id, msg);
    play('notify');
    renderInvites();
  },
  inviteSent(msg) {
    outgoing = msg;
    renderInvites();
    renderUsers();
    renderActions();
  },
  inviteClosed(msg) {
    if (outgoing && outgoing.id === msg.id) {
      if (INVITE_CLOSED[msg.reason]) toast(`${outgoing.to} ${INVITE_CLOSED[msg.reason]}.`);
      outgoing = null;
    }
    incoming.delete(msg.id);
    renderInvites();
    renderUsers();
    renderActions();
  },
  game(msg) {
    announce(game, msg.game);
    game = msg.game;
    gameAt = performance.now();
    renderGame();
    renderUsers();
  },
  error(msg) {
    toast(msg.message);
    // Puts the board back if a move we showed early was refused.
    renderGame();
  },
};

// Plays the sounds for whatever changed between two snapshots. A snapshot of
// a game we were not showing (after a reconnect) is not treated as news.
function announce(prev, next) {
  const same = Boolean(prev && prev.id === next.id);
  if (!same && !next.over && next.moves.length === 0) play('start');
  if (same && next.moves.length > prev.moves.length) {
    const san = next.moves[next.moves.length - 1];
    play(/[+#]/.test(san) ? 'check' : san.includes('x') ? 'capture' : 'move');
  }
  if (same && next.over && !prev.over) play('end', 0.3);
  const offered = (g) => g.drawOffer !== null && g.drawOffer !== g.you;
  if (offered(next) && !(same && offered(prev))) play('notify');
}

// ---- lobby ----

function renderSoundToggle() {
  $('soundToggle').textContent = isMuted() ? 'Sound: off' : 'Sound: on';
}
$('soundToggle').addEventListener('click', () => {
  setMuted(!isMuted());
  renderSoundToggle();
  play('move');
});
renderSoundToggle();

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

const playing = () => Boolean(game && !game.over);

function renderUsers() {
  const sorted = [...users].sort((a, b) => (b.name === me) - (a.name === me) || a.name.localeCompare(b.name));
  $('userCount').textContent = users.length;
  $('users').replaceChildren(...sorted.map((u) => {
    const li = el('li', {},
      el('span', { className: `dot ${u.status}` }),
      el('span', { className: 'userName', textContent: u.name }),
      el('span', { className: `userStatus ${u.status}`, textContent: u.name === me ? `you · ${u.status}` : u.status }));
    if (u.name !== me && u.status === 'idle' && !playing() && !outgoing) {
      li.append(el('button', { textContent: 'Invite', onclick: () => openInvite(u.name) }));
    }
    return li;
  }));
}

function openInvite(name) {
  $('inviteTarget').textContent = name;
  $('inviteDialog').dataset.to = name;
  $('inviteDialog').showModal();
}

function sendInvite(minutes, increment) {
  send({ type: 'invite', to: $('inviteDialog').dataset.to, minutes, increment, variant: $('variantSelect').value });
  $('inviteDialog').close();
}

$('presets').addEventListener('click', (e) => {
  const button = e.target.closest('button');
  if (button) sendInvite(Number(button.dataset.minutes), Number(button.dataset.increment));
});
$('customForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sendInvite($('customMinutes').valueAsNumber, $('customIncrement').valueAsNumber);
});
$('variantSelect').replaceChildren(
  ...Object.values(variants).map((v) => el('option', { value: v.id, textContent: v.name })));
$('inviteCancel').addEventListener('click', () => $('inviteDialog').close());

function renderInvites() {
  const cards = [];
  if (outgoing) {
    cards.push(el('div', { className: 'invite' },
      el('p', { textContent: `Waiting for ${outgoing.to} (${describeInvite(outgoing)})…` }),
      el('button', { textContent: 'Cancel', onclick: () => send({ type: 'cancel', id: outgoing.id }) })));
  }
  for (const invite of incoming.values()) {
    cards.push(el('div', { className: 'invite' },
      el('p', {}, el('strong', { textContent: invite.from }),
        ` challenges you to a ${describeInvite(invite)} game.`),
      el('button', { className: 'primary', textContent: 'Accept', onclick: () => send({ type: 'accept', id: invite.id }) }),
      el('button', { textContent: 'Decline', onclick: () => send({ type: 'decline', id: invite.id }) })));
  }
  $('invites').replaceChildren(...cards);
}

// ---- game ----

const board = createBoard($('board'), {
  onMove: (move) => send({ type: 'move', ...move }),
  choosePromotion,
});

function choosePromotion(types, seat) {
  const dialog = $('promotionDialog');
  return new Promise((resolve) => {
    let choice = null;
    $('promotionChoices').replaceChildren(...types.map((type) => el('button', {
      className: `piece seat${seat}`,
      textContent: glyph(type),
      onclick: () => {
        choice = type;
        dialog.close();
      },
    })));
    dialog.addEventListener('close', () => resolve(choice), { once: true });
    dialog.showModal();
  });
}

// v1 is two players; the seat that is not ours sits at the top.
const opponentSeat = () => game.players.findIndex((_, seat) => seat !== game.you);

const DRAWS = {
  stalemate: 'by stalemate',
  repetition: 'by threefold repetition',
  fifty: 'by the 50-move rule',
  material: 'by insufficient material',
  agreement: 'by agreement',
  timeout: 'on time against a bare king',
};
const WINS = {
  checkmate: 'by checkmate',
  resign: 'by resignation',
  timeout: 'on time',
  abandoned: 'by abandonment',
};

function statusText(variant, mover) {
  if (game.over) {
    const { reason, winner } = game.over;
    if (winner === null) return `Draw ${DRAWS[reason]}`;
    return `${winner === teamOf(variant, game.you) ? 'You won' : 'You lost'} ${WINS[reason]}`;
  }
  if (game.drawOffer !== null && game.drawOffer !== game.you) return `${game.players[game.drawOffer]} offers a draw`;
  const turn = mover === game.you ? 'Your move' : `Waiting for ${game.players[mover]}`;
  return game.check ? `${turn} (check)` : turn;
}

function renderGame() {
  $('game').hidden = !game;
  $('lobbyHint').hidden = Boolean(game);
  if (!game) return;
  const variant = variants[game.variant];
  const state = deserialize(game.state, variant);
  const mover = seatToMove(state);
  const live = !game.over;

  board.update({
    state,
    seat: game.you,
    lastMove: game.lastMove,
    checked: game.check ? kingSquares(state, teamOf(variant, mover)) : [],
    interactive: live && mover === game.you,
  });

  for (const [bar, seat] of [[$('topBar'), opponentSeat()], [$('bottomBar'), game.you]]) {
    bar.querySelector('.swatch').className = `swatch seat${seat}`;
    bar.querySelector('.name').textContent = game.players[seat] + (game.connected[seat] ? '' : ' (disconnected)');
    bar.classList.toggle('active', live && mover === seat);
    bar.dataset.clock = variant.seats[seat].clock;
  }

  $('timeControl').textContent =
    `${variant.name} · ${formatTimeControl(game.initialMs / 60_000, game.incrementMs / 1000)}`;
  $('status').textContent = statusText(variant, mover);
  $('status').classList.toggle('over', !live);

  // One row per round: a move for each seat in turn order.
  const perRound = variant.turnOrder.length;
  const rows = [];
  for (let i = 0; i < game.moves.length; i += perRound) {
    rows.push(el('li', {}, ...game.moves.slice(i, i + perRound).map((san) => el('span', { textContent: san }))));
  }
  $('moves').replaceChildren(...rows);
  $('moves').scrollTop = $('moves').scrollHeight;

  updateClocks();
  renderActions();
}

// The server sends the clocks as of the snapshot; between snapshots the
// running one is counted down locally.
function updateClocks() {
  if (!game) return;
  const elapsed = performance.now() - gameAt;
  for (const bar of [$('topBar'), $('bottomBar')]) {
    const clock = Number(bar.dataset.clock);
    const ms = Math.max(0, game.clocks[clock] - (game.running === clock ? elapsed : 0));
    const node = bar.querySelector('.clock');
    node.textContent = formatClock(ms);
    node.classList.toggle('low', ms < LOW_TIME_MS && !game.over);
  }
  // One warning when our own clock first drops into the last seconds.
  const mine = Number($('bottomBar').dataset.clock);
  if (game.running === mine && lowTimeWarned !== game.id && game.clocks[mine] - elapsed < LOW_TIME_MS) {
    lowTimeWarned = game.id;
    play('lowTime');
  }
}
setInterval(updateClocks, 100);

function renderActions() {
  const box = $('actions');
  box.replaceChildren();
  if (!game) return;
  const button = (textContent, onclick, props = {}) => el('button', { textContent, onclick, ...props });

  if (!game.over) {
    if (game.drawOffer === null) box.append(button('Offer draw', () => send({ type: 'offerDraw' })));
    else if (game.drawOffer === game.you) box.append(button('Draw offered', null, { disabled: true }));
    else {
      box.append(
        button('Accept draw', () => send({ type: 'acceptDraw' }), { className: 'primary' }),
        button('Decline', () => send({ type: 'declineDraw' })));
    }
    box.append(button('Resign', () => {
      if (confirm('Resign this game?')) send({ type: 'resign' });
    }, { className: 'danger' }));
    return;
  }

  const opponent = game.players[opponentSeat()];
  const free = users.some((u) => u.name === opponent && u.status === 'idle');
  const rematch = () => send({
    type: 'invite',
    to: opponent,
    variant: game.variant,
    minutes: game.initialMs / 60_000,
    increment: game.incrementMs / 1000,
  });
  box.append(
    button('Rematch', rematch, { className: 'primary', disabled: !free || Boolean(outgoing) }),
    button('Back to lobby', () => {
      game = null;
      renderGame();
      renderUsers();
    }));
}

connect();

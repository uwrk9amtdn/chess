// Who is online, who is busy, and the invitations between them. The lobby
// knows nothing about any particular game: it asks the game to check an
// invitation's options, to create a match, and forwards the players' actions.
//
// Client -> server: join, invite, cancel, accept, decline, action
// Server -> client: joined, joinError, users, invite, inviteSent,
//                   inviteClosed, match, error

import { randomUUID } from 'node:crypto';

const NAME = /^[\p{L}\p{N}_-]+( [\p{L}\p{N}_-]+)*$/u;
const INVITE_TTL_MS = 30_000;

export class Lobby {
  // `games` is the Map from loadGames. `limits` holds per-game overrides
  // passed to validateOptions, keyed by game id; with `graceMs` it lets tests
  // run short games.
  constructor({ games, limits = {}, graceMs = 30_000 }) {
    this.games = games;
    this.limits = limits;
    this.graceMs = graceMs;
    this.users = new Map(); // lower-cased name -> user
    this.invites = new Map(); // id -> invite
  }

  connect(ws) {
    const conn = { ws, user: null };
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      try {
        this.handle(conn, msg);
      } catch (err) {
        console.error(`Error handling "${msg.type}":`, err);
      }
    });
    ws.on('close', () => this.disconnect(conn));
    ws.on('error', () => {});
  }

  send(target, msg) {
    const ws = target.ws || target.conn?.ws;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  broadcastUsers() {
    const users = [...this.users.values()].map((u) => ({
      name: u.name,
      status: u.match ? 'busy' : 'idle',
      game: u.match ? u.gameId : null,
    }));
    for (const u of this.users.values()) this.send(u, { type: 'users', users });
  }

  handle(conn, msg) {
    if (msg.type === 'join') return this.join(conn, msg);
    const user = conn.user;
    if (!user) return;
    switch (msg.type) {
      case 'invite': return this.invite(user, msg);
      case 'cancel': return this.answerInvite(user, msg.id, 'cancelled');
      case 'decline': return this.answerInvite(user, msg.id, 'declined');
      case 'accept': return this.accept(user, msg.id);
      case 'action': {
        if (!user.match) return;
        const error = user.match.handle(user.seat, msg);
        if (error) this.send(user, { type: 'error', message: error });
      }
    }
  }

  join(conn, msg) {
    if (conn.user) return;
    const name = String(msg.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 16 || !NAME.test(name)) {
      return this.send(conn, {
        type: 'joinError',
        message: 'Use 2 to 16 letters, digits, spaces, "-" or "_".',
      });
    }
    const key = name.toLowerCase();
    let user = this.users.get(key);
    if (user) {
      // The same person coming back (page reload, dropped connection) proves
      // it with the token they were given when they first joined.
      if (typeof msg.token !== 'string' || msg.token !== user.token) {
        return this.send(conn, { type: 'joinError', message: 'That name is already taken.' });
      }
      if (user.conn) {
        user.conn.user = null;
        user.conn.ws.close();
      }
      clearTimeout(user.dropTimer);
    } else {
      user = { name, key, token: randomUUID(), conn: null, match: null, gameId: null, seat: null, dropTimer: null };
      this.users.set(key, user);
    }
    user.conn = conn;
    conn.user = user;
    this.send(user, {
      type: 'joined',
      name: user.name,
      token: user.token,
      games: [...this.games.values()].map((g) => g.meta),
      // True when a match is about to be resent rather than started.
      resumed: Boolean(user.match),
    });
    this.broadcastUsers();
    if (user.match) user.match.setConnected(user.seat, true);
  }

  disconnect(conn) {
    const user = conn.user;
    if (!user) return;
    conn.user = null;
    user.conn = null;
    if (!user.match) return this.removeUser(user);
    // Mid-match: keep the seat for a while so a reload does not lose the
    // game. What the absence costs meanwhile (a running clock, say) is up to
    // the game.
    user.match.setConnected(user.seat, false);
    user.dropTimer = setTimeout(() => {
      if (user.match) user.match.abandon(user.seat);
      else this.removeUser(user);
    }, this.graceMs);
    user.dropTimer.unref();
  }

  removeUser(user) {
    clearTimeout(user.dropTimer);
    if (this.users.get(user.key) !== user) return;
    this.users.delete(user.key);
    this.closeInvitesOf(user, 'unavailable');
    this.broadcastUsers();
  }

  invite(from, msg) {
    const fail = (message) => this.send(from, { type: 'error', message });
    const to = this.users.get(String(msg.to ?? '').toLowerCase());
    const game = typeof msg.game === 'string' ? this.games.get(msg.game) : undefined;
    if (!game) return fail('Unknown game.');
    if (!to || to === from) return fail('That player is not available.');
    if (from.match) return fail('You are already in a game.');
    if (to.match) return fail(`${to.name} is busy.`);
    if ([...this.invites.values()].some((i) => i.from === from)) {
      return fail('You already have an invitation waiting.');
    }
    const requested = msg.options && typeof msg.options === 'object' ? msg.options : {};
    const { options, error } = game.validateOptions(requested, this.limits[game.meta.id]);
    if (error) return fail(error);

    const invite = { id: randomUUID(), from, to, game, options };
    invite.timer = setTimeout(() => this.closeInvite(invite, 'expired'), INVITE_TTL_MS);
    invite.timer.unref();
    this.invites.set(invite.id, invite);
    const details = { id: invite.id, game: game.meta.id, options };
    this.send(to, { type: 'invite', from: from.name, ...details });
    this.send(from, { type: 'inviteSent', to: to.name, ...details });
  }

  closeInvite(invite, reason) {
    if (!this.invites.delete(invite.id)) return;
    clearTimeout(invite.timer);
    const msg = { type: 'inviteClosed', id: invite.id, reason };
    this.send(invite.from, msg);
    this.send(invite.to, msg);
  }

  closeInvitesOf(user, reason) {
    for (const invite of [...this.invites.values()]) {
      if (invite.from === user || invite.to === user) this.closeInvite(invite, reason);
    }
  }

  // The sender cancels, the receiver declines.
  answerInvite(user, id, reason) {
    const invite = this.invites.get(id);
    if (!invite) return;
    if (user === (reason === 'cancelled' ? invite.from : invite.to)) this.closeInvite(invite, reason);
  }

  accept(user, id) {
    const invite = this.invites.get(id);
    if (!invite || invite.to !== user) return;
    const { from, to } = invite;
    if (from.match || to.match) return this.closeInvite(invite, 'unavailable');
    this.closeInvite(invite, 'accepted');
    this.closeInvitesOf(from, 'unavailable');
    this.closeInvitesOf(to, 'unavailable');
    this.startMatch(Math.random() < 0.5 ? [from, to] : [to, from], invite);
  }

  // `seated` lists the users in seat order.
  startMatch(seated, { game, options }) {
    const match = game.createMatch({
      players: seated.map((u) => u.name),
      options,
      onChange: (m) => this.matchChanged(m, game, seated),
    });
    seated.forEach((u, seat) => {
      u.match = match;
      u.gameId = game.meta.id;
      u.seat = seat;
    });
    this.broadcastUsers();
    this.matchChanged(match, game, seated);
  }

  matchChanged(match, game, seated) {
    seated.forEach((u, seat) => {
      if (u.match === match) this.send(u, { type: 'match', game: game.meta.id, snapshot: match.snapshot(seat) });
    });
    if (!match.over) return;
    // The match is finished: everyone is free again, and anyone who never
    // reconnected leaves the lobby.
    const players = seated.filter((u) => u.match === match);
    for (const u of players) {
      u.match = null;
      u.gameId = null;
      u.seat = null;
    }
    for (const u of players) if (!u.conn) this.removeUser(u);
    this.broadcastUsers();
  }
}

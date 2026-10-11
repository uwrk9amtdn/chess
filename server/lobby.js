// Who is online, who is busy, and the invitations between them.
//
// Client -> server: join, invite, cancel, accept, decline, move, resign,
//                   offerDraw, acceptDraw, declineDraw
// Server -> client: joined, joinError, users, invite, inviteSent,
//                   inviteClosed, game, error

import { randomUUID } from 'node:crypto';
import { variants } from '../shared/variants.js';
import { Game } from './game.js';

const NAME = /^[\p{L}\p{N}_-]+( [\p{L}\p{N}_-]+)*$/u;
const INVITE_TTL_MS = 30_000;

export class Lobby {
  // `minMinutes` and `graceMs` are options so tests can use short games.
  constructor({ minMinutes = 1, maxMinutes = 60, maxIncrement = 30, graceMs = 30_000 } = {}) {
    this.limits = { minMinutes, maxMinutes, maxIncrement };
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
    const users = [...this.users.values()].map((u) => ({ name: u.name, status: u.game ? 'busy' : 'idle' }));
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
    }
    const game = user.game;
    if (!game) return;
    switch (msg.type) {
      case 'move': {
        const error = game.move(user.seat, msg);
        if (error) this.send(user, { type: 'error', message: error });
        return;
      }
      case 'resign': return game.resign(user.seat);
      case 'offerDraw': return game.offerDraw(user.seat);
      case 'acceptDraw': return game.answerDraw(user.seat, true);
      case 'declineDraw': return game.answerDraw(user.seat, false);
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
      user = { name, key, token: randomUUID(), conn: null, game: null, seat: null, dropTimer: null };
      this.users.set(key, user);
    }
    user.conn = conn;
    conn.user = user;
    this.send(user, { type: 'joined', name: user.name, token: user.token });
    this.broadcastUsers();
    if (user.game) user.game.setConnected(user.seat, true);
  }

  disconnect(conn) {
    const user = conn.user;
    if (!user) return;
    conn.user = null;
    user.conn = null;
    if (!user.game) return this.removeUser(user);
    // Mid-game: keep the seat for a while so a reload does not lose the game.
    // The player's clock keeps running in the meantime.
    user.game.setConnected(user.seat, false);
    user.dropTimer = setTimeout(() => {
      if (user.game) user.game.abandon(user.seat);
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
    const { minMinutes, maxMinutes, maxIncrement } = this.limits;
    const { minutes, increment, variant = 'standard' } = msg;
    if (!to || to === from) return fail('That player is not available.');
    if (from.game) return fail('You are already in a game.');
    if (to.game) return fail(`${to.name} is busy.`);
    if ([...this.invites.values()].some((i) => i.from === from)) {
      return fail('You already have an invitation waiting.');
    }
    if (typeof minutes !== 'number' || !(minutes >= minMinutes && minutes <= maxMinutes) ||
        !Number.isInteger(increment) || increment < 0 || increment > maxIncrement) {
      return fail(`Choose ${minMinutes} to ${maxMinutes} minutes and 0 to ${maxIncrement} seconds increment.`);
    }
    if (!Object.hasOwn(variants, variant)) return fail('Unknown game type.');
    const invite = { id: randomUUID(), from, to, minutes, increment, variant };
    invite.timer = setTimeout(() => this.closeInvite(invite, 'expired'), INVITE_TTL_MS);
    invite.timer.unref();
    this.invites.set(invite.id, invite);
    this.send(to, { type: 'invite', id: invite.id, from: from.name, minutes, increment, variant });
    this.send(from, { type: 'inviteSent', id: invite.id, to: to.name, minutes, increment, variant });
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
    if (from.game || to.game) return this.closeInvite(invite, 'unavailable');
    this.closeInvite(invite, 'accepted');
    this.closeInvitesOf(from, 'unavailable');
    this.closeInvitesOf(to, 'unavailable');
    this.startGame(Math.random() < 0.5 ? [from, to] : [to, from], invite);
  }

  // `seated` lists the users in seat order.
  startGame(seated, { variant, minutes, increment }) {
    const game = new Game({
      variant: variants[variant],
      players: seated.map((u) => u.name),
      initialMs: Math.round(minutes * 60_000),
      incrementMs: increment * 1000,
      onChange: (g) => this.gameChanged(g, seated),
    });
    seated.forEach((u, seat) => {
      u.game = game;
      u.seat = seat;
    });
    this.broadcastUsers();
    this.gameChanged(game, seated);
  }

  gameChanged(game, seated) {
    seated.forEach((u, seat) => {
      if (u.game === game) this.send(u, { type: 'game', game: game.snapshot(seat) });
    });
    if (!game.over) return;
    // The game is finished: everyone is free again, and anyone who never
    // reconnected leaves the lobby.
    const players = seated.filter((u) => u.game === game);
    for (const u of players) {
      u.game = null;
      u.seat = null;
    }
    for (const u of players) if (!u.conn) this.removeUser(u);
    this.broadcastUsers();
  }
}

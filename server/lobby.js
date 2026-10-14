// Who is online, who is busy, and the invitations between them. The lobby
// knows nothing about any particular game: it asks the game to check an
// invitation's options, to create a match, and forwards the players' actions.
//
// Client -> server: join, invite, cancel, accept, decline, bot, action, chat,
//                   watch, unwatch, follow, unfollow, history, review
// Server -> client: joined, joinError, users, matches, invite, inviteSent,
//                   inviteClosed, match, preview, chat, chatLog, history,
//                   restart, error

import { randomUUID } from 'node:crypto';
import { Archive } from './archive.js';

const NAME = /^[\p{L}\p{N}_-]+( [\p{L}\p{N}_-]+)*$/u;
const INVITE_TTL_MS = 30_000;
const CHAT_MAX_LENGTH = 140;
const CHAT_MIN_GAP_MS = 500;
const CHAT_LOG_SIZE = 100;
// Previews are pushed on every change only while a game has at most this many
// matches going; beyond it they are refreshed when a match starts or ends.
const PREVIEW_LIMIT = 12;
const PAUSED = 'The server restarts for an update in a few minutes, so no new games start until then.';

export class Lobby {
  // `games` is the Map from loadGames and `archive` is where finished matches
  // go. `stats` hears what happens, for the admin panel (see stats.js).
  // `limits` holds per-game overrides
  // passed to validateOptions, keyed by game id; with `graceMs` it lets tests
  // run short games.
  constructor({ games, archive = new Archive(), stats = null, limits = {}, graceMs = 30_000 }) {
    this.games = games;
    this.archive = archive;
    this.stats = stats;
    this.limits = limits;
    this.graceMs = graceMs;
    this.users = new Map(); // lower-cased name -> user
    this.invites = new Map(); // id -> invite
    this.matches = new Map(); // id -> { match, game, seated, options, watchers } while it is played
    // A restart for an update, once announced: { at }, the time it may
    // happen; it waits beyond that for the matches being played to end.
    this.restart = null;
  }

  // ---- restarting for an update (see server/index.js and DEPLOY.md) ----

  // Announces a restart in `ms`, or sooner if one is announced already, and
  // stops new matches from starting until then.
  scheduleRestart(ms) {
    const at = Date.now() + Math.max(0, ms);
    if (!this.restart || at < this.restart.at) this.restart = { at };
    for (const invite of [...this.invites.values()]) this.closeInvite(invite, 'unavailable');
    this.broadcastRestart();
    return this.restartStatus();
  }

  cancelRestart() {
    this.restart = null;
    this.broadcastRestart();
  }

  // Where an announced restart stands: how long until it may happen, how
  // many matches are still being played, and whether it may happen now.
  restartStatus() {
    if (!this.restart) return null;
    const msLeft = Math.max(0, this.restart.at - Date.now());
    return { msLeft, games: this.matches.size, ready: msLeft === 0 && this.matches.size === 0 };
  }

  // What the players' screens show about it: nothing (msLeft null), or the
  // time left and the matches still being played.
  restartNotice() {
    const status = this.restartStatus();
    return { type: 'restart', msLeft: status ? status.msLeft : null, games: status ? status.games : 0 };
  }

  broadcastRestart() {
    const msg = this.restartNotice();
    for (const u of this.users.values()) this.send(u, msg);
  }

  // Who is online and what is being played, for the admin panel.
  overview() {
    return {
      players: [...this.users.values()].map((u) => ({
        name: u.name,
        connected: Boolean(u.conn),
        game: u.match ? u.gameId : null,
        watching: Boolean(u.watching),
      })),
      matches: [...this.matches.values()].map((m) => ({
        id: m.match.id,
        game: m.game.meta.id,
        players: m.seated.map((u) => u.name),
        vsBot: m.bots.some(Boolean),
        options: m.options,
        startedAt: m.startedAt,
        spectators: m.watchers.size,
      })),
    };
  }

  connect(ws) {
    const conn = { ws, user: null };
    this.stats?.connected();
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
        this.stats?.error();
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

  // The matches anyone may watch, each with a preview of how it stands now
  // if the game makes those.
  liveMatches() {
    return [...this.matches.values()].map((m) => ({
      id: m.match.id,
      game: m.game.meta.id,
      players: m.seated.map((u) => u.name),
      options: m.options,
      preview: m.preview,
    }));
  }

  // Works out a match's preview again and says whether it changed.
  refreshPreview(live) {
    const preview = live.game.preview?.(live.match.snapshot(null)) ?? null;
    const changed = JSON.stringify(preview) !== JSON.stringify(live.preview);
    live.preview = preview;
    return changed;
  }

  // Someone looking at a game's list of matches follows that game: they get
  // the list as it is now and then each match's preview as it changes.
  follow(user, game) {
    if (typeof game !== 'string' || !this.games.has(game)) return;
    user.following = game;
    for (const live of this.matches.values()) this.refreshPreview(live);
    this.send(user, { type: 'matches', matches: this.liveMatches() });
  }

  broadcastMatches() {
    for (const live of this.matches.values()) this.refreshPreview(live);
    const matches = this.liveMatches();
    for (const u of this.users.values()) this.send(u, { type: 'matches', matches });
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
      case 'bot': return this.playBot(user, msg);
      case 'chat': return this.chat(user, msg.text);
      case 'watch': return this.watch(user, msg.id);
      case 'unwatch': return this.stopWatching(user);
      case 'follow': return this.follow(user, msg.game);
      case 'unfollow': user.following = null; return;
      case 'history': return this.history(user, msg);
      case 'review':
        this.review(user, msg.id).catch((err) => console.error('Error handling "review":', err));
        return;
      case 'action': {
        if (!user.match) return;
        // A player whose browser thinks for a bot also sends that seat's actions.
        const seat = msg.bot === true && user.botSeat !== null ? user.botSeat : user.seat;
        const error = user.match.handle(seat, msg);
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
      user = {
        name, key, token: randomUUID(), conn: null, match: null, gameId: null, seat: null, botSeat: null,
        dropTimer: null,
        room: null, lastChatAt: 0, watching: null, following: null,
      };
      this.users.set(key, user);
      this.stats?.onlineNow(this.users.size);
    }
    this.stats?.joined(user.name);
    user.conn = conn;
    conn.user = user;
    this.send(user, {
      type: 'joined',
      name: user.name,
      token: user.token,
      games: [...this.games.values()].map((g) => g.meta),
      previewLimit: PREVIEW_LIMIT,
      // True when a match is about to be resent rather than started.
      resumed: Boolean(user.match),
    });
    this.broadcastUsers();
    user.following = null;
    this.send(user, { type: 'matches', matches: this.liveMatches() });
    if (this.restart) this.send(user, this.restartNotice());
    if (user.room) this.send(user, { type: 'chatLog', id: user.room.id, messages: user.room.log });
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
    this.stats?.dropped();
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
    this.stats?.onlineNow(this.users.size);
    user.room = null;
    this.stopWatching(user);
    this.closeInvitesOf(user, 'unavailable');
    this.broadcastUsers();
  }

  invite(from, msg) {
    const fail = (message) => this.send(from, { type: 'error', message });
    const to = this.users.get(String(msg.to ?? '').toLowerCase());
    const game = typeof msg.game === 'string' ? this.games.get(msg.game) : undefined;
    if (!game) return fail('Unknown game.');
    if (!to || to === from) return fail('That player is not available.');
    if (this.restart) return fail(PAUSED);
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
    if (this.restart) {
      this.closeInvite(invite, 'unavailable');
      return this.send(user, { type: 'error', message: PAUSED });
    }
    const { from, to } = invite;
    if (from.match || to.match) return this.closeInvite(invite, 'unavailable');
    this.closeInvite(invite, 'accepted');
    this.closeInvitesOf(from, 'unavailable');
    this.closeInvitesOf(to, 'unavailable');
    this.startMatch(Math.random() < 0.5 ? [from, to] : [to, from], invite);
  }

  // A match against a bot: the game says what a bot may be and what it is
  // called, and the player's own browser plays its moves. Nobody is behind the
  // bot's seat, so its place in `seated` is taken by a stand-in that is not in
  // `users` and has no connection.
  playBot(user, msg) {
    const fail = (message) => this.send(user, { type: 'error', message });
    const game = typeof msg.game === 'string' ? this.games.get(msg.game) : undefined;
    if (!game) return fail('Unknown game.');
    if (!game.validateBot) return fail('This game cannot be played against the computer.');
    if (this.restart) return fail(PAUSED);
    if (user.match) return fail('You are already in a game.');
    const requested = msg.options && typeof msg.options === 'object' ? msg.options : {};
    const { options, error } = game.validateOptions(requested, this.limits[game.meta.id]);
    if (error) return fail(error);
    const wanted = msg.bot && typeof msg.bot === 'object' ? msg.bot : {};
    const { bot, name, error: botError } = game.validateBot(wanted, options);
    if (botError) return fail(botError);

    this.closeInvitesOf(user, 'unavailable');
    const seat = msg.seat === 0 || msg.seat === 1 ? msg.seat : Math.floor(Math.random() * 2);
    const seated = [user, { name, bot: true, conn: null }];
    if (seat === 1) seated.reverse();
    this.startMatch(seated, { game, options }, seated.map((u) => (u.bot ? bot : null)));
  }

  // `seated` lists the users in seat order. `bots` has, for a seat played by
  // a bot, what the game made of the request for one.
  startMatch(seated, { game, options }, bots = seated.map(() => null)) {
    const match = game.createMatch({
      players: seated.map((u) => u.name),
      options,
      bots,
      onChange: (m) => this.matchChanged(m, game, seated),
    });
    // The players of a match can talk to each other. The room outlives the
    // match, until its players move on to another one or leave.
    const room = { id: match.id, members: seated, log: [] };
    const entry = { match, game, seated, options, bots, startedAt: Date.now(), watchers: new Set(), preview: null };
    this.matches.set(match.id, entry);
    this.stats?.matchStarted({ game: game.meta.id, options, bots });
    this.refreshPreview(entry);
    seated.forEach((u, seat) => {
      this.stopWatching(u);
      u.room = room;
      u.match = match;
      u.gameId = game.meta.id;
      u.seat = seat;
      u.botSeat = null;
    });
    const botSeat = seated.findIndex((u) => u.bot);
    if (botSeat !== -1) for (const u of seated) if (!u.bot) u.botSeat = botSeat;
    this.broadcastUsers();
    this.broadcastMatches();
    this.matchChanged(match, game, seated);
  }

  // Anyone who is not playing may look on. A spectator has no seat: they get
  // the snapshot for seat `null` and nothing they send reaches the match.
  watch(user, id) {
    if (user.match) return this.send(user, { type: 'error', message: 'You are in a game yourself.' });
    const live = this.matches.get(id);
    if (!live) return this.send(user, { type: 'error', message: 'That game is no longer being played.' });
    if (user.watching !== live) {
      this.stopWatching(user);
      user.watching = live;
      live.watchers.add(user);
      // A game that counts its audience tells everyone, the newcomer included.
      if (live.match.setSpectators) return live.match.setSpectators(live.watchers.size);
    }
    this.send(user, { type: 'match', game: live.game.meta.id, snapshot: live.match.snapshot(null) });
  }

  stopWatching(user) {
    const live = user.watching;
    if (!live) return;
    user.watching = null;
    live.watchers.delete(user);
    live.match.setSpectators?.(live.watchers.size);
  }

  // A page of the finished matches of one game, newest first.
  history(user, msg) {
    if (typeof msg.game !== 'string' || !this.games.has(msg.game)) return;
    const before = Number.isInteger(msg.before) ? msg.before : undefined;
    const player = typeof msg.player === 'string' ? msg.player : undefined;
    const page = this.archive.list(msg.game, { before, player });
    this.send(user, { type: 'history', game: msg.game, before: before ?? null, ...page });
  }

  // A finished match is shown the way a spectator saw it end.
  async review(user, id) {
    const record = typeof id === 'string' ? await this.archive.get(id) : null;
    if (user.match) return this.send(user, { type: 'error', message: 'You are in a game yourself.' });
    if (!record) return this.send(user, { type: 'error', message: 'That game could not be found.' });
    this.stopWatching(user);
    this.send(user, { type: 'match', game: record.game, snapshot: record.snapshot });
  }

  // Tells the followers of a game what one of its matches looks like now,
  // unless nothing visible changed or there are too many matches to keep up.
  pushPreview(live) {
    if (!live || !live.game.preview) return;
    const id = live.game.meta.id;
    let count = 0;
    for (const m of this.matches.values()) if (m.game === live.game) count++;
    if (count > PREVIEW_LIMIT || !this.refreshPreview(live)) return;
    const msg = { type: 'preview', id: live.match.id, preview: live.preview };
    for (const u of this.users.values()) if (u.following === id) this.send(u, msg);
  }

  chat(user, text) {
    const room = user.room;
    if (!room || typeof text !== 'string') return;
    const clean = text.trim().replace(/\s+/g, ' ');
    if (!clean || clean.length > CHAT_MAX_LENGTH) return;
    const now = Date.now();
    if (now - user.lastChatAt < CHAT_MIN_GAP_MS) return;
    user.lastChatAt = now;
    const message = { from: user.name, text: clean };
    room.log.push(message);
    if (room.log.length > CHAT_LOG_SIZE) room.log.shift();
    this.stats?.chat();
    for (const u of room.members) {
      if (u.room === room) this.send(u, { type: 'chat', id: room.id, ...message });
    }
  }

  matchChanged(match, game, seated) {
    seated.forEach((u, seat) => {
      if (u.match === match) this.send(u, { type: 'match', game: game.meta.id, snapshot: match.snapshot(seat) });
    });
    const live = this.matches.get(match.id);
    if (live) {
      const msg = { type: 'match', game: game.meta.id, snapshot: match.snapshot(null) };
      for (const u of live.watchers) this.send(u, msg);
    }
    if (!match.over) {
      this.pushPreview(live);
      return;
    }
    // The match is finished: everyone is free again, and anyone who never
    // reconnected leaves the lobby. Spectators keep the last thing they saw.
    if (live) {
      for (const u of live.watchers) u.watching = null;
      this.matches.delete(match.id);
      this.stats?.matchEnded({ game: game.meta.id, bots: live.bots, over: match.over, durationMs: Date.now() - live.startedAt });
      this.archive.save({
        id: match.id,
        game: game.meta.id,
        endedAt: Date.now(),
        players: seated.map((u) => u.name),
        options: live.options,
        over: match.over,
        snapshot: match.snapshot(null),
      });
    }
    const players = seated.filter((u) => u.match === match);
    for (const u of players) {
      u.match = null;
      u.gameId = null;
      u.seat = null;
      u.botSeat = null;
    }
    for (const u of players) if (!u.conn) this.removeUser(u);
    this.broadcastUsers();
    this.broadcastMatches();
    // One match fewer to wait for.
    if (this.restart) this.broadcastRestart();
  }
}

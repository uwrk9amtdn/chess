// One game of Mill in progress: the authoritative position, the clocks and
// the result. Players are addressed by seat (seat 0 plays White and moves
// first); the lobby maps seats to connections.

import { randomUUID } from 'node:crypto';
import { VARIANTS, createGame, tryMove, status, moveName, boardKey } from '../shared/rules.js';

export class MillMatch {
  // `players` holds one name per seat and `options` is what validateOptions
  // returned. `bots` says, per seat, which level of bot plays it (or null);
  // its moves arrive like anyone's, from the browser of the player it faces.
  // `onChange(match)` fires after anything the players should see, including
  // the end of the game.
  constructor({ players, options, bots, onChange }) {
    this.id = randomUUID();
    this.players = players;
    this.options = options;
    this.variant = VARIANTS[options.variant];
    this.bots = bots ?? players.map(() => null);
    this.onChange = onChange;
    this.state = createGame(this.variant);
    // The position before each move and after the last, for taking moves back.
    this.history = [this.state];
    this.initialMs = Math.round(options.minutes * 60_000);
    this.incrementMs = options.increment * 1000;
    this.clocks = players.map(() => this.initialMs);
    this.turnStartedAt = Date.now();
    this.moves = [];
    // The same moves as { from, to, remove }, so a client can replay them.
    this.played = [];
    // What both clocks showed after each move, for looking back at the game.
    this.clockHistory = [];
    this.lastMove = null;
    this.drawOffer = null;
    // The seat asking to take its last move back, and how often that was
    // granted: a client can tell by it that the moves it knew were replaced.
    this.takebackOffer = null;
    this.takebacks = 0;
    this.connected = players.map(() => true);
    this.spectators = 0;
    this.over = null;
    this.armFlag();
  }

  armFlag() {
    clearTimeout(this.flagTimer);
    const left = this.clocks[this.state.turn] - (Date.now() - this.turnStartedAt);
    this.flagTimer = setTimeout(() => this.flag(), Math.max(0, left));
    this.flagTimer.unref();
  }

  flag() {
    if (this.over) return;
    const seat = this.state.turn;
    this.clocks[seat] = 0;
    this.finish('timeout', 1 - seat);
  }

  finish(reason, winner) {
    if (this.over) return;
    clearTimeout(this.flagTimer);
    if (reason !== 'timeout') {
      const seat = this.state.turn;
      this.clocks[seat] = Math.max(0, this.clocks[seat] - (Date.now() - this.turnStartedAt));
    }
    this.drawOffer = null;
    this.takebackOffer = null;
    this.over = { reason, winner };
    this.onChange(this);
  }

  // The lobby forwards every message from a player here. Returns an error
  // message for the player, or null.
  handle(seat, action) {
    switch (action.action) {
      case 'move': return this.move(seat, action);
      case 'resign': this.finish('resign', 1 - seat); return null;
      case 'offerDraw': this.offerDraw(seat); return null;
      case 'acceptDraw': this.answerDraw(seat, true); return null;
      case 'declineDraw': this.answerDraw(seat, false); return null;
      case 'offerTakeback': this.offerTakeback(seat); return null;
      case 'acceptTakeback': this.answerTakeback(seat, true); return null;
      case 'declineTakeback': this.answerTakeback(seat, false); return null;
      default: return 'Unknown action';
    }
  }

  // `request` is { from, to, remove }: `from` when moving a piece rather
  // than putting one down, `remove` when the move closes a mill. Returns an
  // error message, or null when the move was played.
  move(seat, request) {
    if (this.over) return 'The game is over';
    if (seat !== this.state.turn) return 'It is not your turn';
    const move = { from: request.from, to: request.to, remove: request.remove };
    const result = tryMove(this.state, this.variant, move);
    if (result.error) return result.error;

    const now = Date.now();
    const left = this.clocks[seat] - (now - this.turnStartedAt);
    if (left <= 0) {
      this.flag();
      return null;
    }
    this.clocks[seat] = left + this.incrementMs;
    // Only the fields the move has, so it replays as it was made.
    const made = Object.fromEntries(Object.entries(move).filter(([, value]) => value !== undefined));
    this.moves.push(moveName(this.variant, made));
    this.played.push(made);
    this.clockHistory.push(this.clocks.slice());
    this.state = result.state;
    this.history.push(this.state);
    this.lastMove = made;
    this.drawOffer = null;
    // Whoever plays on no longer wants their move back. The other side's
    // reply leaves the request standing: granting it undoes the reply too.
    if (this.takebackOffer === seat) this.takebackOffer = null;
    this.turnStartedAt = now;

    const ending = status(this.state, this.variant);
    if (ending.over) this.finish(ending.reason, ending.winner);
    else {
      this.armFlag();
      this.onChange(this);
    }
    return null;
  }

  // The player left and did not come back in time.
  abandon(seat) {
    this.finish('abandoned', 1 - seat);
  }

  // Not against the computer, which has no say in a draw.
  offerDraw(seat) {
    if (this.over || this.drawOffer !== null || this.bots.some(Boolean)) return;
    this.drawOffer = seat;
    this.onChange(this);
  }

  // Only the other player can answer an offer.
  answerDraw(seat, accept) {
    if (this.over || this.drawOffer === null || this.drawOffer === seat) return;
    if (accept) this.finish('agreement', null);
    else {
      this.drawOffer = null;
      this.onChange(this);
    }
  }

  // How many moves are left once `seat` has taken its last one back, or null
  // if it has not moved yet.
  takebackPly(seat) {
    for (let ply = this.played.length - 1; ply >= 0; ply--) {
      if (this.history[ply].turn === seat) return ply;
    }
    return null;
  }

  offerTakeback(seat) {
    if (this.over || this.takebackOffer !== null || this.takebackPly(seat) === null) return;
    this.takebackOffer = seat;
    this.onChange(this);
  }

  // Only the other player can answer. Granted, the game goes back to where
  // the asking player was last to move, clocks included.
  answerTakeback(seat, accept) {
    if (this.over || this.takebackOffer === null || this.takebackOffer === seat) return;
    if (accept) {
      const ply = this.takebackPly(this.takebackOffer);
      this.moves.length = this.played.length = this.clockHistory.length = ply;
      this.history.length = ply + 1;
      this.state = this.history[ply];
      this.clocks = ply ? this.clockHistory[ply - 1].slice() : this.players.map(() => this.initialMs);
      this.turnStartedAt = Date.now();
      this.lastMove = ply ? this.played[ply - 1] : null;
      this.drawOffer = null;
      this.takebacks++;
      this.armFlag();
    }
    this.takebackOffer = null;
    this.onChange(this);
  }

  setConnected(seat, connected) {
    this.connected[seat] = connected;
    this.onChange(this);
  }

  setSpectators(count) {
    this.spectators = count;
    this.onChange(this);
  }

  // Everything the player in `seat` needs to draw the game right now. A
  // spectator (`seat` is null) sees the same; Mill has no hidden information.
  snapshot(seat) {
    const clocks = this.clocks.slice();
    let running = null;
    if (!this.over) {
      running = this.state.turn;
      clocks[running] = Math.max(0, clocks[running] - (Date.now() - this.turnStartedAt));
    }
    return {
      id: this.id,
      players: this.players,
      bots: this.bots,
      you: seat,
      options: this.options,
      board: boardKey(this.state.board),
      turn: this.state.turn,
      inHand: this.state.inHand,
      onBoard: this.state.onBoard,
      quiet: this.state.quiet,
      moves: this.moves,
      played: this.played,
      clocks,
      running,
      initialMs: this.initialMs,
      incrementMs: this.incrementMs,
      clockHistory: this.clockHistory,
      lastMove: this.lastMove,
      drawOffer: this.drawOffer,
      takebackOffer: this.takebackOffer,
      takebacks: this.takebacks,
      connected: this.connected,
      spectators: this.spectators,
      over: this.over,
    };
  }
}

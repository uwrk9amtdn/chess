// One chess game in progress: the authoritative position, the clocks and the
// result. Players are addressed by seat; the lobby maps seats to connections.

import { randomUUID } from 'node:crypto';
import {
  createGame, findMove, applyMove, status, toSan, seatToMove, teamOf, opposingTeam, inCheck, serialize, canWinOnTime,
} from '../shared/engine.js';
import { variants } from '../shared/variants.js';

export class ChessMatch {
  // `players` holds one name per seat and `options` is what validateOptions
  // returned. `bots` says, per seat, which level of bot plays it (or null);
  // its moves arrive like anyone's, from the browser of the player it faces.
  // `onChange(match)` fires after anything the players should see, including
  // the end of the game.
  constructor({ players, options, bots, onChange }) {
    const variant = variants[options.variant];
    const initialMs = Math.round(options.minutes * 60_000);
    this.id = randomUUID();
    this.variant = variant;
    this.players = players;
    this.options = options;
    this.bots = bots ?? players.map(() => null);
    this.initialMs = initialMs;
    this.incrementMs = options.increment * 1000;
    this.onChange = onChange;
    // Variants with several starting positions get one at random.
    this.start = variant.starts ? Math.floor(Math.random() * variant.starts) : null;
    this.state = createGame(variant, this.start ?? undefined);
    // The position before each move and after the last, for taking moves back.
    this.history = [this.state];
    // Remaining time per clock as of `turnStartedAt`. Seats sharing a clock
    // index (team mates) share the time.
    const clockCount = Math.max(...variant.seats.map((s) => s.clock)) + 1;
    this.clocks = new Array(clockCount).fill(initialMs);
    this.turnStartedAt = Date.now();
    this.moves = [];
    // The same moves as { from, to, promotion }, so a client can replay them.
    this.played = [];
    // What every clock showed after each move, for looking back at the game.
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

  runningClock() {
    return this.variant.seats[seatToMove(this.state)].clock;
  }

  armFlag() {
    clearTimeout(this.flagTimer);
    const left = this.clocks[this.runningClock()] - (Date.now() - this.turnStartedAt);
    this.flagTimer = setTimeout(() => this.flag(), Math.max(0, left));
    this.flagTimer.unref();
  }

  flag() {
    if (this.over) return;
    const loser = teamOf(this.variant, seatToMove(this.state));
    const winner = opposingTeam(this.variant, loser);
    this.clocks[this.runningClock()] = 0;
    // Running out of time against a side that could never win is a draw.
    this.finish('timeout', canWinOnTime(this.state, winner) ? winner : null);
  }

  finish(reason, winner) {
    if (this.over) return;
    clearTimeout(this.flagTimer);
    if (reason !== 'timeout') {
      const c = this.runningClock();
      this.clocks[c] = Math.max(0, this.clocks[c] - (Date.now() - this.turnStartedAt));
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
      case 'resign': this.resign(seat); return null;
      case 'offerDraw': this.offerDraw(seat); return null;
      case 'acceptDraw': this.answerDraw(seat, true); return null;
      case 'declineDraw': this.answerDraw(seat, false); return null;
      case 'offerTakeback': this.offerTakeback(seat); return null;
      case 'acceptTakeback': this.answerTakeback(seat, true); return null;
      case 'declineTakeback': this.answerTakeback(seat, false); return null;
      default: return 'Unknown action';
    }
  }

  // Returns an error message, or null when the move was played.
  move(seat, request) {
    if (this.over) return 'The game is over';
    if (seat !== seatToMove(this.state)) return 'It is not your turn';
    const move = findMove(this.state, request);
    if (!move) return 'Illegal move';

    const now = Date.now();
    const c = this.runningClock();
    const left = this.clocks[c] - (now - this.turnStartedAt);
    if (left <= 0) {
      this.flag();
      return null;
    }
    this.clocks[c] = left + this.incrementMs;
    this.moves.push(toSan(this.state, move));
    this.played.push({ from: move.from, to: move.to, promotion: move.promotion, drop: move.drop });
    this.clockHistory.push(this.clocks.slice());
    this.state = applyMove(this.state, move);
    this.history.push(this.state);
    this.lastMove = { from: move.from, to: move.to };
    this.drawOffer = null;
    // Whoever plays on no longer wants their move back. The other side's
    // reply leaves the request standing: granting it undoes the reply too.
    if (this.takebackOffer === seat) this.takebackOffer = null;
    this.turnStartedAt = now;

    const result = status(this.state);
    if (result.over) this.finish(result.reason, result.winner);
    else {
      this.armFlag();
      this.onChange(this);
    }
    return null;
  }

  resign(seat) {
    this.finish('resign', opposingTeam(this.variant, teamOf(this.variant, seat)));
  }

  // The player left and did not come back in time.
  abandon(seat) {
    this.finish('abandoned', opposingTeam(this.variant, teamOf(this.variant, seat)));
  }

  // Not against the computer, which has no say in a draw.
  offerDraw(seat) {
    if (this.over || this.drawOffer !== null || this.bots.some(Boolean)) return;
    this.drawOffer = seat;
    this.onChange(this);
  }

  // Only the other team can answer an offer.
  answerDraw(seat, accept) {
    if (this.over || this.drawOffer === null) return;
    if (teamOf(this.variant, this.drawOffer) === teamOf(this.variant, seat)) return;
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
      if (seatToMove(this.history[ply]) === seat) return ply;
    }
    return null;
  }

  offerTakeback(seat) {
    if (this.over || this.takebackOffer !== null || this.takebackPly(seat) === null) return;
    this.takebackOffer = seat;
    this.onChange(this);
  }

  // Only the other team can answer. Granted, the game goes back to where the
  // asking player was last to move, clocks included.
  answerTakeback(seat, accept) {
    if (this.over || this.takebackOffer === null) return;
    if (teamOf(this.variant, this.takebackOffer) === teamOf(this.variant, seat)) return;
    if (accept) {
      const ply = this.takebackPly(this.takebackOffer);
      this.moves.length = this.played.length = this.clockHistory.length = ply;
      this.history.length = ply + 1;
      this.state = this.history[ply];
      this.clocks = ply ? this.clockHistory[ply - 1].slice() : this.clocks.map(() => this.initialMs);
      this.turnStartedAt = Date.now();
      this.lastMove = ply ? { from: this.played[ply - 1].from, to: this.played[ply - 1].to } : null;
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
  // spectator (`seat` is null) sees the same; chess has no hidden information.
  snapshot(seat) {
    const clocks = this.clocks.slice();
    let running = null;
    if (!this.over) {
      running = this.runningClock();
      clocks[running] = Math.max(0, clocks[running] - (Date.now() - this.turnStartedAt));
    }
    return {
      id: this.id,
      variant: this.variant.id,
      start: this.start,
      players: this.players,
      bots: this.bots,
      you: seat,
      options: this.options,
      state: serialize(this.state),
      clocks,
      running,
      initialMs: this.initialMs,
      incrementMs: this.incrementMs,
      moves: this.moves,
      played: this.played,
      clockHistory: this.clockHistory,
      lastMove: this.lastMove,
      check: inCheck(this.state, teamOf(this.variant, seatToMove(this.state))),
      drawOffer: this.drawOffer,
      takebackOffer: this.takebackOffer,
      takebacks: this.takebacks,
      connected: this.connected,
      spectators: this.spectators,
      over: this.over,
    };
  }
}

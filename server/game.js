// One game in progress: the authoritative position, the clocks and the result.
// Players are addressed by seat; the lobby maps seats to connections.

import { randomUUID } from 'node:crypto';
import {
  createGame, findMove, applyMove, status, toSan, seatToMove, teamOf, opposingTeam, inCheck, serialize,
} from '../shared/engine.js';

export class Game {
  // `players` holds one name per seat. `onChange(game)` fires after anything
  // the players should see, including the end of the game.
  constructor({ variant, players, initialMs, incrementMs, onChange }) {
    this.id = randomUUID();
    this.variant = variant;
    this.players = players;
    this.initialMs = initialMs;
    this.incrementMs = incrementMs;
    this.onChange = onChange;
    this.state = createGame(variant);
    // Remaining time per clock as of `turnStartedAt`. Seats sharing a clock
    // index (team mates) share the time.
    const clockCount = Math.max(...variant.seats.map((s) => s.clock)) + 1;
    this.clocks = new Array(clockCount).fill(initialMs);
    this.turnStartedAt = Date.now();
    this.moves = [];
    this.lastMove = null;
    this.drawOffer = null;
    this.connected = players.map(() => true);
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
    // Running out of time against a side that has only kings left is a draw.
    const canMate = this.state.board.some(
      (p) => p && p.type !== 'k' && teamOf(this.variant, p.seat) === winner,
    );
    this.finish('timeout', canMate ? winner : null);
  }

  finish(reason, winner) {
    if (this.over) return;
    clearTimeout(this.flagTimer);
    if (reason !== 'timeout') {
      const c = this.runningClock();
      this.clocks[c] = Math.max(0, this.clocks[c] - (Date.now() - this.turnStartedAt));
    }
    this.drawOffer = null;
    this.over = { reason, winner };
    this.onChange(this);
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
    this.state = applyMove(this.state, move);
    this.lastMove = { from: move.from, to: move.to };
    this.drawOffer = null;
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

  offerDraw(seat) {
    if (this.over || this.drawOffer !== null) return;
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

  setConnected(seat, connected) {
    this.connected[seat] = connected;
    this.onChange(this);
  }

  // Everything the player in `seat` needs to draw the game right now.
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
      players: this.players,
      you: seat,
      state: serialize(this.state),
      clocks,
      running,
      initialMs: this.initialMs,
      incrementMs: this.incrementMs,
      moves: this.moves,
      lastMove: this.lastMove,
      check: inCheck(this.state, teamOf(this.variant, seatToMove(this.state))),
      drawOffer: this.drawOffer,
      connected: this.connected,
      over: this.over,
    };
  }
}

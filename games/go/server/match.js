// One game of Go in progress: the authoritative position, the clocks, the
// counting at the end and the result. Players are addressed by seat (0 is
// Black); the lobby maps seats to connections.

import { randomUUID } from 'node:crypto';
import { createGame, tryMove, moveName, boardKey, chainAt, score, komiFor, EMPTY } from '../shared/rules.js';
import { initialClock, spend, afterMove, timeLeft, periodMsOf } from '../shared/clock.js';
import { guessDead } from '../shared/playout.js';

// How long the players have to agree on the dead stones once both have
// passed. After that the game is counted with the server's guess.
export const SCORING_MS = 3 * 60_000;

export class GoMatch {
  // `players` holds one name per seat and `options` is what validateOptions
  // returned. `bots` says, per seat, which level of bot plays it (or null);
  // its moves arrive like anyone's, from the browser of the player it faces.
  // `onChange(match)` fires after anything the players should see, including
  // the end of the game.
  constructor({ players, options, bots, onChange }) {
    this.id = randomUUID();
    this.players = players;
    this.options = options;
    this.bots = bots ?? players.map(() => null);
    this.onChange = onChange;
    this.komi = komiFor(options.handicap);
    this.periodMs = periodMsOf(options);
    this.state = createGame(options.size, options.handicap);
    // The position before each move and after the last, for taking moves back.
    this.history = [this.state];
    this.clocks = players.map(() => initialClock(options));
    this.turnStartedAt = Date.now();
    this.moves = [];
    // The same moves as { point } or { pass: true }, so a client can replay them.
    this.played = [];
    // What both clocks showed after each move, for looking back at the game.
    this.clockHistory = [];
    this.lastMove = null;
    // The seat asking to take its last move back, and how often that was
    // granted: a client can tell by it that the moves it knew were replaced.
    this.takebackOffer = null;
    this.takebacks = 0;
    // Once both have passed: { dead, guess, accepted, endsAt }, the stones
    // marked dead, the server's own guess, who agrees and until when.
    this.scoring = null;
    // The dead stones the game was counted with.
    this.dead = [];
    this.connected = players.map(() => true);
    this.spectators = 0;
    this.over = null;
    this.armFlag();
  }

  armFlag() {
    clearTimeout(this.flagTimer);
    const left = timeLeft(this.clocks[this.state.turn], this.periodMs) - (Date.now() - this.turnStartedAt);
    this.flagTimer = setTimeout(() => this.flag(), Math.max(0, left));
    this.flagTimer.unref();
  }

  flag() {
    if (this.over || this.scoring) return;
    const seat = this.state.turn;
    this.clocks[seat] = spend(this.clocks[seat], Infinity, this.periodMs);
    this.finish('timeout', 1 - seat);
  }

  finish(reason, winner, counted = {}) {
    if (this.over) return;
    clearTimeout(this.flagTimer);
    clearTimeout(this.scoringTimer);
    // The clock of whoever was thinking stops where it is.
    if (reason !== 'timeout' && !this.scoring) {
      const seat = this.state.turn;
      this.clocks[seat] = spend(this.clocks[seat], Date.now() - this.turnStartedAt, this.periodMs);
    }
    this.takebackOffer = null;
    this.over = { reason, winner, ...counted };
    this.onChange(this);
  }

  // The lobby forwards every message from a player here. Returns an error
  // message for the player, or null.
  handle(seat, action) {
    switch (action.action) {
      case 'move': return this.play(seat, { point: action.point });
      case 'pass': return this.play(seat, { pass: true });
      case 'resign': this.finish('resign', 1 - seat); return null;
      case 'offerTakeback': this.offerTakeback(seat); return null;
      case 'acceptTakeback': this.answerTakeback(seat, true); return null;
      case 'declineTakeback': this.answerTakeback(seat, false); return null;
      case 'toggleDead': return this.toggleDead(action.point);
      case 'acceptScore': return this.acceptScore(seat);
      case 'resume': return this.resume();
      default: return 'Unknown action';
    }
  }

  // Returns an error message, or null when the move was played.
  play(seat, move) {
    if (this.over) return 'The game is over';
    if (this.scoring) return 'Play has stopped: agree on the dead stones, or resume play';
    if (seat !== this.state.turn) return 'It is not your turn';
    const result = tryMove(this.state, move);
    if (result.error) return result.error;

    const now = Date.now();
    const clock = afterMove(this.clocks[seat], now - this.turnStartedAt, this.options);
    if (!clock) {
      this.flag();
      return null;
    }
    this.clocks[seat] = clock;
    this.moves.push(moveName(this.state.size, move));
    this.played.push(move);
    this.clockHistory.push(this.clocks.slice());
    this.state = result.state;
    this.history.push(this.state);
    this.lastMove = move.pass ? null : move.point;
    // Whoever plays on no longer wants their move back. The other side's
    // reply leaves the request standing: granting it undoes the reply too.
    if (this.takebackOffer === seat) this.takebackOffer = null;
    this.turnStartedAt = now;
    if (this.state.passes >= 2) this.startScoring();
    else this.armFlag();
    this.onChange(this);
    return null;
  }

  // Both have passed: the clocks stop while the players agree on which
  // stones are dead, starting from the server's guess.
  startScoring() {
    clearTimeout(this.flagTimer);
    const guess = guessDead(this.state);
    this.scoring = { dead: guess, guess, accepted: this.players.map(() => false), endsAt: Date.now() + SCORING_MS };
    this.scoringTimer = setTimeout(() => this.count(this.scoring.guess, 'scoreTimeout'), SCORING_MS);
    this.scoringTimer.unref();
  }

  count(dead, reason) {
    this.dead = dead;
    const { black, white, winner } = score(this.state, dead, this.komi);
    this.finish(reason, winner, { black, white });
  }

  // Marks a whole chain dead, or alive again. Either player may; any change
  // needs both to agree again.
  toggleDead(point) {
    if (!this.scoring || this.over) return 'Stones are only marked dead once both players have passed';
    const { board, size } = this.state;
    if (!Number.isInteger(point) || board[point] === undefined || board[point] === EMPTY) return 'There is no stone there';
    const { stones } = chainAt(board, size, point);
    const dead = new Set(this.scoring.dead);
    const wasDead = stones.every((s) => dead.has(s));
    for (const s of stones) {
      if (wasDead) dead.delete(s);
      else dead.add(s);
    }
    this.scoring.dead = [...dead].sort((a, b) => a - b);
    this.scoring.accepted = this.players.map(() => false);
    this.onChange(this);
    return null;
  }

  acceptScore(seat) {
    if (!this.scoring || this.over) return 'There is no score to accept';
    this.scoring.accepted[seat] = true;
    if (this.scoring.accepted.every(Boolean)) this.count(this.scoring.dead, 'score');
    else this.onChange(this);
    return null;
  }

  // Either player may go back to playing, to settle a disagreement on the
  // board. The player who passed first moves.
  resume() {
    if (!this.scoring || this.over) return 'Play has not stopped';
    clearTimeout(this.scoringTimer);
    this.scoring = null;
    this.state = { ...this.state, passes: 0 };
    this.history[this.history.length - 1] = this.state;
    this.turnStartedAt = Date.now();
    this.armFlag();
    this.onChange(this);
    return null;
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
    if (this.over || this.scoring || this.takebackOffer !== null || this.takebackPly(seat) === null) return;
    this.takebackOffer = seat;
    this.onChange(this);
  }

  // Only the other player can answer. Granted, the game goes back to where
  // the asking player was last to move, clocks included.
  answerTakeback(seat, accept) {
    if (this.over || this.scoring || this.takebackOffer === null || this.takebackOffer === seat) return;
    if (accept) {
      const ply = this.takebackPly(this.takebackOffer);
      this.moves.length = this.played.length = this.clockHistory.length = ply;
      this.history.length = ply + 1;
      this.state = this.history[ply];
      this.clocks = ply ? this.clockHistory[ply - 1].slice() : this.players.map(() => initialClock(this.options));
      this.turnStartedAt = Date.now();
      const last = this.played[ply - 1];
      this.lastMove = last && !last.pass ? last.point : null;
      this.takebacks++;
      this.armFlag();
    }
    this.takebackOffer = null;
    this.onChange(this);
  }

  // The player left and did not come back in time.
  abandon(seat) {
    this.finish('abandoned', 1 - seat);
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
  // spectator (`seat` is null) sees the same; Go has no hidden information.
  snapshot(seat) {
    const clocks = this.clocks.slice();
    let running = null;
    if (!this.over && !this.scoring) {
      running = this.state.turn;
      clocks[running] = spend(clocks[running], Date.now() - this.turnStartedAt, this.periodMs);
    }
    const { scoring } = this;
    return {
      id: this.id,
      players: this.players,
      bots: this.bots,
      you: seat,
      options: this.options,
      komi: this.komi,
      board: boardKey(this.state.board),
      turn: this.state.turn,
      passes: this.state.passes,
      captures: this.state.captures,
      clocks,
      running,
      periodMs: this.periodMs,
      moves: this.moves,
      played: this.played,
      clockHistory: this.clockHistory,
      lastMove: this.lastMove,
      takebackOffer: this.takebackOffer,
      takebacks: this.takebacks,
      scoring: !this.over && scoring && {
        dead: scoring.dead,
        accepted: scoring.accepted,
        msLeft: Math.max(0, scoring.endsAt - Date.now()),
      },
      dead: this.dead,
      connected: this.connected,
      spectators: this.spectators,
      over: this.over,
    };
  }
}

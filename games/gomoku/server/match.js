// One game of Gomoku in progress: the authoritative position, the opening,
// the clocks and the result. Players are addressed by seat; the lobby maps
// seats to connections.
//
// Without an opening rule seat 0 plays Black. With Swap2 the colours are
// decided first: seat 0 puts down three stones (black, white, black); seat 1
// then takes a colour, or puts down two more (white, black) and leaves seat
// 0 to take one. Play goes on from there with White to move.

import { randomUUID } from 'node:crypto';
import { createGame, tryMove, pointName, boardKey, isFull, BLACK, WHITE } from '../shared/rules.js';

// The Swap2 steps, who acts in each, and how many stones lie on the board
// when a placing step is done.
const STEPS = {
  place3: { seat: 0, until: 3, next: 'choose' },
  choose: { seat: 1 },
  place2: { seat: 1, until: 5, next: 'choose2' },
  choose2: { seat: 0 },
};

export class GomokuMatch {
  // `players` holds one name per seat and `options` is what validateOptions
  // returned. `bots` says, per seat, which level of bot plays it (or null);
  // its moves arrive like anyone's, from the browser of the player it faces.
  // `onChange(match)` fires after anything the players should see, including
  // the end of the game.
  constructor({ players, options, bots, onChange }) {
    this.id = randomUUID();
    this.players = players;
    this.options = options;
    this.variant = options.variant;
    this.bots = bots ?? players.map(() => null);
    this.onChange = onChange;
    this.state = createGame(options.size);
    // The position before each stone and after the last, for taking moves back.
    this.history = [this.state];
    this.initialMs = Math.round(options.minutes * 60_000);
    this.incrementMs = options.increment * 1000;
    this.clocks = players.map(() => this.initialMs);
    this.turnStartedAt = Date.now();
    this.moves = [];
    // The same stones as points, so a client can replay them.
    this.played = [];
    // What both clocks showed after each stone, for looking back at the game.
    this.clockHistory = [];
    // The colour each seat plays, or null while Swap2 is deciding.
    this.colours = options.opening === 'swap2' ? [null, null] : [BLACK, WHITE];
    // The Swap2 step under way (see STEPS), or null once play has started.
    this.step = options.opening === 'swap2' ? 'place3' : null;
    // What was decided in the opening, as { seat, choice } with choice
    // 'black', 'white' or 'placeTwo', and after how many stones.
    this.choices = [];
    // Stones down when play proper began; takebacks go no further back.
    this.openingPlies = 0;
    this.lastMove = null;
    // The winning row, once there is one.
    this.line = null;
    // The seat asking to take its last move back, and how often that was
    // granted: a client can tell by it that the moves it knew were replaced.
    this.takebackOffer = null;
    this.takebacks = 0;
    this.connected = players.map(() => true);
    this.spectators = 0;
    this.over = null;
    this.armFlag();
  }

  // The seat that is to act: in the opening the step says, after it the
  // seat playing the colour to move.
  actor() {
    return this.step ? STEPS[this.step].seat : this.colours.indexOf(this.state.turn);
  }

  armFlag() {
    clearTimeout(this.flagTimer);
    const left = this.clocks[this.actor()] - (Date.now() - this.turnStartedAt);
    this.flagTimer = setTimeout(() => this.flag(), Math.max(0, left));
    this.flagTimer.unref();
  }

  flag() {
    if (this.over) return;
    const seat = this.actor();
    this.clocks[seat] = 0;
    this.finish('timeout', 1 - seat);
  }

  // Stops the acting seat's clock and adds the increment. False if it had
  // run out, in which case the game is lost on time.
  spendClock(seat) {
    const now = Date.now();
    const left = this.clocks[seat] - (now - this.turnStartedAt);
    if (left <= 0) {
      this.flag();
      return false;
    }
    this.clocks[seat] = left + this.incrementMs;
    this.turnStartedAt = now;
    return true;
  }

  finish(reason, winner) {
    if (this.over) return;
    clearTimeout(this.flagTimer);
    if (reason !== 'timeout') {
      const seat = this.actor();
      this.clocks[seat] = Math.max(0, this.clocks[seat] - (Date.now() - this.turnStartedAt));
    }
    this.takebackOffer = null;
    // The winner's colour too, which may not be decided yet.
    this.over = { reason, winner, colour: winner === null ? null : this.colours[winner] };
    this.onChange(this);
  }

  // The lobby forwards every message from a player here. Returns an error
  // message for the player, or null.
  handle(seat, action) {
    switch (action.action) {
      case 'move': return this.play(seat, action.point);
      case 'choose': return this.choose(seat, action.choice);
      case 'resign': this.finish('resign', 1 - seat); return null;
      case 'offerTakeback': this.offerTakeback(seat); return null;
      case 'acceptTakeback': this.answerTakeback(seat, true); return null;
      case 'declineTakeback': this.answerTakeback(seat, false); return null;
      default: return 'Unknown action';
    }
  }

  // Returns an error message, or null when the stone was played.
  play(seat, point) {
    if (this.over) return 'The game is over';
    if (this.step && !STEPS[this.step].until) return 'A colour has to be chosen first';
    if (seat !== this.actor()) return 'It is not your turn';
    const result = tryMove(this.state, point, this.variant);
    if (result.error) return result.error;
    if (!this.spendClock(seat)) return null;

    this.moves.push(pointName(this.state.size, point));
    this.played.push(point);
    this.clockHistory.push(this.clocks.slice());
    this.state = result.state;
    this.history.push(this.state);
    this.lastMove = point;
    // Whoever plays on no longer wants their move back. The other side's
    // reply leaves the request standing: granting it undoes the reply too.
    if (this.takebackOffer === seat) this.takebackOffer = null;
    if (this.step && this.state.count === STEPS[this.step].until) this.step = STEPS[this.step].next;

    if (result.line) {
      this.line = result.line;
      this.finish('five', seat);
    } else if (isFull(this.state)) this.finish('full', null);
    else {
      this.armFlag();
      this.onChange(this);
    }
    return null;
  }

  // A Swap2 decision: 'black' or 'white' for the colour to play, or, at the
  // first choice only, 'placeTwo' to put down two more stones.
  choose(seat, choice) {
    if (this.over) return 'The game is over';
    if (this.step !== 'choose' && this.step !== 'choose2') return 'There is nothing to choose';
    if (seat !== this.actor()) return 'It is not your turn';
    if (choice !== 'black' && choice !== 'white' && !(choice === 'placeTwo' && this.step === 'choose')) {
      return 'Choose black or white';
    }
    if (!this.spendClock(seat)) return null;
    this.choices.push({ seat, choice, stones: this.played.length });
    if (choice === 'placeTwo') this.step = 'place2';
    else {
      const colour = choice === 'black' ? BLACK : WHITE;
      this.colours[seat] = colour;
      this.colours[1 - seat] = 1 - colour;
      this.step = null;
      this.openingPlies = this.played.length;
    }
    this.armFlag();
    this.onChange(this);
    return null;
  }

  // The player left and did not come back in time.
  abandon(seat) {
    this.finish('abandoned', 1 - seat);
  }

  // How many stones are left once `seat` has taken its last one back, or
  // null if it has no stone of the game proper to take back.
  takebackPly(seat) {
    for (let ply = this.played.length - 1; ply >= this.openingPlies; ply--) {
      if (this.colours[seat] === this.history[ply].turn) return ply;
    }
    return null;
  }

  offerTakeback(seat) {
    if (this.over || this.step || this.takebackOffer !== null || this.takebackPly(seat) === null) return;
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
  // spectator (`seat` is null) sees the same; Gomoku has no hidden
  // information.
  snapshot(seat) {
    const clocks = this.clocks.slice();
    let running = null;
    if (!this.over) {
      running = this.actor();
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
      colours: this.colours,
      step: this.step,
      actor: this.over ? null : this.actor(),
      choices: this.choices,
      openingPlies: this.openingPlies,
      moves: this.moves,
      played: this.played,
      clocks,
      running,
      initialMs: this.initialMs,
      incrementMs: this.incrementMs,
      clockHistory: this.clockHistory,
      lastMove: this.lastMove,
      line: this.line,
      takebackOffer: this.takebackOffer,
      takebacks: this.takebacks,
      connected: this.connected,
      spectators: this.spectators,
      over: this.over,
    };
  }
}

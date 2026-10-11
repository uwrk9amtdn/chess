// The smallest possible game, for testing the lobby without chess: the
// first player to send "claim" wins.

import { randomUUID } from 'node:crypto';
import meta from '../meta.js';

class PickMatch {
  constructor({ players, options, onChange }) {
    Object.assign(this, { id: randomUUID(), players, options, onChange, over: null });
    this.connected = players.map(() => true);
  }

  handle(seat, action) {
    if (this.over) return 'The game is over';
    if (action.action !== 'claim') return 'Unknown action';
    this.finish({ reason: 'claimed', winner: seat });
    return null;
  }

  finish(over) {
    if (this.over) return;
    this.over = over;
    this.onChange(this);
  }

  abandon(seat) {
    this.finish({ reason: 'abandoned', winner: 1 - seat });
  }

  setConnected(seat, connected) {
    this.connected[seat] = connected;
    this.onChange(this);
  }

  snapshot(seat) {
    const { id, players, options, over, connected } = this;
    return { id, players, you: seat, options, over, connected };
  }
}

export default {
  meta,
  validateOptions(options) {
    const { prize = 1 } = options;
    if (!Number.isInteger(prize) || prize < 1 || prize > 3) return { error: 'The prize must be 1 to 3.' };
    return { options: { prize } };
  },
  createMatch: (args) => new PickMatch(args),
};

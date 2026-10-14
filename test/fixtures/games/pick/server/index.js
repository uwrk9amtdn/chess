// The smallest possible game, for testing the lobby without chess: the
// first player to send "claim" wins. "poke" changes what the match looks like
// without ending it, and "resign" ends it without a move.

import { randomUUID } from 'node:crypto';
import meta from '../meta.js';

class PickMatch {
  constructor({ players, options, bots, onChange }) {
    Object.assign(this, { id: randomUUID(), players, options, bots, onChange, over: null });
    this.connected = players.map(() => true);
    this.moves = [];
  }

  handle(seat, action) {
    if (this.over) return 'The game is over';
    if (action.action === 'poke') {
      this.pokes = (this.pokes || 0) + 1;
      this.moves.push('poke');
      this.onChange(this);
      return null;
    }
    if (action.action === 'resign') {
      this.finish({ reason: 'resigned', winner: 1 - seat });
      return null;
    }
    if (action.action !== 'claim') return 'Unknown action';
    this.moves.push('claim');
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

  setSpectators(count) {
    this.spectators = count;
    this.onChange(this);
  }

  snapshot(seat) {
    const { id, players, options, bots, over, connected, spectators = 0, pokes = 0, moves } = this;
    return { id, players, bots, you: seat, options, over, connected, spectators, pokes, moves };
  }
}

export default {
  meta,
  validateOptions(options) {
    const { prize = 1 } = options;
    if (!Number.isInteger(prize) || prize < 1 || prize > 3) return { error: 'The prize must be 1 to 3.' };
    return { options: { prize } };
  },
  validateBot(bot) {
    if (bot.mood !== 'calm' && bot.mood !== 'wild') return { error: 'The bot must be calm or wild.' };
    return { bot: { mood: bot.mood }, name: `${bot.mood} bot` };
  },
  createMatch: (args) => new PickMatch(args),
  preview: (snapshot) => ({ claimed: Boolean(snapshot.over), pokes: snapshot.pokes }),
};

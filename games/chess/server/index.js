// Chess as the platform sees it. See games/README.md for the contract.

import meta from '../meta.js';
import { variants, BOT_LEVELS, STOCKFISH_VARIANTS } from '../shared/variants.js';
import { deserialize, kingSquares, seatToMove, teamOf } from '../shared/engine.js';
import { ChessMatch } from './match.js';

const DEFAULT_LIMITS = { minMinutes: 1, maxMinutes: 60, maxIncrement: 30 };

export default {
  meta,

  // Options are { variant, minutes, increment }: minutes per player and
  // seconds added after each move. `limits` lets tests allow very short games.
  validateOptions(options, limits) {
    const { minMinutes, maxMinutes, maxIncrement } = { ...DEFAULT_LIMITS, ...limits };
    const { minutes, increment, variant = 'standard' } = options;
    if (typeof variant !== 'string' || !Object.hasOwn(variants, variant)) return { error: 'Unknown game type.' };
    if (typeof minutes !== 'number' || !(minutes >= minMinutes && minutes <= maxMinutes) ||
        !Number.isInteger(increment) || increment < 0 || increment > maxIncrement) {
      return { error: `Choose ${minMinutes} to ${maxMinutes} minutes and 0 to ${maxIncrement} seconds increment.` };
    }
    return { options: { variant, minutes, increment } };
  },

  // A bot is { level }, 1 (weakest) to 8. Its name says which engine the
  // player's browser will run for this variant (see client/bot).
  validateBot(bot, options) {
    const { level } = bot;
    if (!Number.isInteger(level) || level < 1 || level > BOT_LEVELS) return { error: `Choose a level from 1 to ${BOT_LEVELS}.` };
    return { bot: { level }, name: `${STOCKFISH_VARIANTS.includes(options.variant) ? 'Stockfish' : 'Computer'} level ${level}` };
  },

  createMatch: (args) => new ChessMatch(args),

  // A position small enough to send by the dozen: the pieces as "q1" (type
  // and seat) or "" per square, the last move and any king in check.
  preview(snapshot) {
    const variant = variants[snapshot.variant];
    const state = deserialize(snapshot.state, variant);
    return {
      variant: variant.id,
      pieces: state.board.map((p) => (p ? p.type + p.seat : '')),
      lastMove: snapshot.lastMove,
      checked: snapshot.check ? kingSquares(state, teamOf(variant, seatToMove(state))) : [],
    };
  },
};

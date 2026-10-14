// Mill as the platform sees it. See games/README.md for the contract.

import meta from '../meta.js';
import { VARIANTS } from '../shared/rules.js';
import { BOT_LEVELS } from '../shared/search.js';
import { MillMatch } from './match.js';

const DEFAULT_LIMITS = { minMinutes: 1, maxMinutes: 60, maxIncrement: 30 };

export default {
  meta,

  // Options are { variant, minutes, increment }: the board and Fischer's
  // minutes per player and seconds added after each move. `limits` lets
  // tests allow very short games.
  validateOptions(options, limits) {
    const { minMinutes, maxMinutes, maxIncrement } = { ...DEFAULT_LIMITS, ...limits };
    const { variant = 'nine', minutes, increment } = options;
    if (typeof variant !== 'string' || !Object.hasOwn(VARIANTS, variant)) return { error: 'Unknown game type.' };
    if (typeof minutes !== 'number' || !(minutes >= minMinutes && minutes <= maxMinutes) ||
        !Number.isInteger(increment) || increment < 0 || increment > maxIncrement) {
      return { error: `Choose ${minMinutes} to ${maxMinutes} minutes and 0 to ${maxIncrement} seconds increment.` };
    }
    return { options: { variant, minutes, increment } };
  },

  // A bot is { level }, 1 (weakest) to 8; see shared/search.js.
  validateBot(bot) {
    const { level } = bot;
    if (!Number.isInteger(level) || level < 1 || level > BOT_LEVELS) return { error: `Choose a level from 1 to ${BOT_LEVELS}.` };
    return { bot: { level }, name: `Computer level ${level}` };
  },

  createMatch: (args) => new MillMatch(args),

  // The pieces as one character per point ('w' first seat, 'b' second,
  // '.' empty) and the last move.
  preview(snapshot) {
    return { variant: snapshot.options.variant, board: snapshot.board, lastMove: snapshot.lastMove };
  },
};

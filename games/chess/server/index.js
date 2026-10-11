// Chess as the platform sees it. See games/README.md for the contract.

import meta from '../meta.js';
import { variants } from '../shared/variants.js';
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

  createMatch: (args) => new ChessMatch(args),
};

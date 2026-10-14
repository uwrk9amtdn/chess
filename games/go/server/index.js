// Go as the platform sees it. See games/README.md for the contract.

import meta from '../meta.js';
import { SIZES, MAX_HANDICAP } from '../shared/rules.js';
import { BOT_LEVELS } from '../shared/mcts.js';
import { GoMatch } from './match.js';

const DEFAULT_LIMITS = { minMinutes: 1, maxMinutes: 90, maxIncrement: 60, minPeriod: 5, maxPeriod: 120, maxPeriods: 10 };

const inRange = (value, min, max) => typeof value === 'number' && value >= min && value <= max;

export default {
  meta,

  // Options are { size, handicap, clock, minutes, ... }: with clock
  // 'fischer', `increment` seconds after each move; with 'byoyomi', main
  // `minutes` (possibly none) and then `periods` periods of `period` seconds.
  // `limits` lets tests allow very short games.
  validateOptions(options, limits) {
    const { minMinutes, maxMinutes, maxIncrement, minPeriod, maxPeriod, maxPeriods } = { ...DEFAULT_LIMITS, ...limits };
    const { size = 19, handicap = 0, clock = 'fischer', minutes } = options;
    if (!SIZES.includes(size)) return { error: `Choose a board of ${SIZES.join(', ')} lines.` };
    if (!Number.isInteger(handicap) || handicap === 1 || handicap < 0 || handicap > MAX_HANDICAP) {
      return { error: `Choose no handicap, or 2 to ${MAX_HANDICAP} stones.` };
    }
    if (clock === 'fischer') {
      const { increment } = options;
      if (!inRange(minutes, minMinutes, maxMinutes) || !Number.isInteger(increment) || increment < 0 || increment > maxIncrement) {
        return { error: `Choose ${minMinutes} to ${maxMinutes} minutes and 0 to ${maxIncrement} seconds increment.` };
      }
      return { options: { size, handicap, clock, minutes, increment } };
    }
    if (clock === 'byoyomi') {
      const { periods, period } = options;
      if (!inRange(minutes, 0, maxMinutes) || !Number.isInteger(periods) || periods < 1 || periods > maxPeriods ||
          !inRange(period, minPeriod, maxPeriod)) {
        return {
          error: `Choose up to ${maxMinutes} minutes, then 1 to ${maxPeriods} periods of ${minPeriod} to ${maxPeriod} seconds.`,
        };
      }
      return { options: { size, handicap, clock, minutes, periods, period } };
    }
    return { error: 'Unknown kind of clock.' };
  },

  // A bot is { level }, 1 (weakest) to 8; see shared/mcts.js.
  validateBot(bot) {
    const { level } = bot;
    if (!Number.isInteger(level) || level < 1 || level > BOT_LEVELS) return { error: `Choose a level from 1 to ${BOT_LEVELS}.` };
    return { bot: { level }, name: `Computer level ${level}` };
  },

  createMatch: (args) => new GoMatch(args),

  // The stones as one character per point ('x' Black, 'o' White, '.' empty)
  // and the last stone played.
  preview(snapshot) {
    return { size: snapshot.options.size, board: snapshot.board, lastMove: snapshot.lastMove };
  },
};

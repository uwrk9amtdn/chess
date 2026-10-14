// Gomoku as the platform sees it. See games/README.md for the contract.

import meta from '../meta.js';
import { VARIANTS } from '../shared/rules.js';
import { BOT_LEVELS } from '../shared/search.js';
import { GomokuMatch } from './match.js';

const DEFAULT_LIMITS = { minMinutes: 1, maxMinutes: 60, maxIncrement: 30 };
export const OPENINGS = ['none', 'swap2'];

export default {
  meta,

  // Options are { variant, size, opening, minutes, increment }: the rules,
  // the board, whether Swap2 decides the colours, and Fischer's minutes per
  // player and seconds added after each move. `limits` lets tests allow very
  // short games.
  validateOptions(options, limits) {
    const { minMinutes, maxMinutes, maxIncrement } = { ...DEFAULT_LIMITS, ...limits };
    const { variant = 'freestyle', size = 15, opening = 'none', minutes, increment } = options;
    if (typeof variant !== 'string' || !Object.hasOwn(VARIANTS, variant)) return { error: 'Unknown rules.' };
    if (!VARIANTS[variant].sizes.includes(size)) {
      return { error: `${VARIANTS[variant].name} is played on ${VARIANTS[variant].sizes.map((s) => `${s}x${s}`).join(' or ')}.` };
    }
    if (!OPENINGS.includes(opening)) return { error: 'Unknown opening rule.' };
    if (typeof minutes !== 'number' || !(minutes >= minMinutes && minutes <= maxMinutes) ||
        !Number.isInteger(increment) || increment < 0 || increment > maxIncrement) {
      return { error: `Choose ${minMinutes} to ${maxMinutes} minutes and 0 to ${maxIncrement} seconds increment.` };
    }
    return { options: { variant, size, opening, minutes, increment } };
  },

  // A bot is { level }, 1 (weakest) to 8; see shared/search.js.
  validateBot(bot) {
    const { level } = bot;
    if (!Number.isInteger(level) || level < 1 || level > BOT_LEVELS) return { error: `Choose a level from 1 to ${BOT_LEVELS}.` };
    return { bot: { level }, name: `Computer level ${level}` };
  },

  createMatch: (args) => new GomokuMatch(args),

  // The stones as one character per point ('x' Black, 'o' White, '.' empty),
  // the last stone and the winning row, if any.
  preview(snapshot) {
    return { size: snapshot.options.size, board: snapshot.board, lastMove: snapshot.lastMove, line: snapshot.line };
  },
};

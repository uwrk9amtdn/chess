// The search of shared/mcts.js on a thread of its own, so the page stays
// responsive while the bot thinks. Asked with { id, size, handicap, komi,
// played, passes, level, timeMs }, it answers { id, move, winrate }.

import { createGame, applyMove } from '../../shared/rules.js';
import { chooseMove } from '../../shared/mcts.js';

onmessage = ({ data }) => {
  const { id, size, handicap, komi, played, passes, level, timeMs } = data;
  // Passes before play was resumed no longer count.
  const state = { ...played.reduce(applyMove, createGame(size, handicap)), passes };
  const { move, winrate } = chooseMove(state, { komi, level, timeMs });
  postMessage({ id, move, winrate });
};

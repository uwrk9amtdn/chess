// The search of shared/search.js on a thread of its own, so the page stays
// responsive while the bot thinks. Asked { id, variant, played, level, ms },
// it answers { id, move, score }.

import { VARIANTS, createGame, applyMove } from '../../shared/rules.js';
import { chooseMove } from '../../shared/search.js';

onmessage = ({ data }) => {
  const { id, variant, played, level, ms } = data;
  const v = VARIANTS[variant];
  const state = played.reduce((s, move) => applyMove(s, v, move), createGame(v));
  const found = chooseMove(state, v, level, { ms });
  postMessage({ id, move: found.move, score: found.score });
};

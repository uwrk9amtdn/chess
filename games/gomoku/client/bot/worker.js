// The search of shared/search.js on a thread of its own, so the page stays
// responsive while the bot thinks. Asked { id, kind, size, variant, played,
// level, ms }, it answers { id, point } for kind 'move', { id, colour } for
// 'colour' (a Swap2 choice) and { id, points } for 'opening' (Swap2's first
// three stones).

import { createGame, applyMove } from '../../shared/rules.js';
import { chooseMove, chooseColour, openingStones } from '../../shared/search.js';

onmessage = ({ data }) => {
  const { id, kind, size, variant, played, level, ms } = data;
  if (kind === 'opening') {
    postMessage({ id, points: openingStones(size) });
    return;
  }
  const state = played.reduce((s, p) => applyMove(s, p, variant), createGame(size));
  if (kind === 'colour') postMessage({ id, colour: chooseColour(state, variant) });
  else postMessage({ id, point: chooseMove(state, variant, level, { ms }).point });
};

// The search of shared/search.js on a thread of its own, so the page stays
// responsive while the bot thinks. Asked with { id, variant, start, played,
// level, timeMs }, it answers { id, move, score }.

import { variants } from '../../shared/variants.js';
import { createGame, applyMove } from '../../shared/engine.js';
import { search, levelSettings } from '../../shared/search.js';

onmessage = ({ data }) => {
  const { id, variant, start, played, level, timeMs } = data;
  let state = createGame(variants[variant], start ?? undefined);
  for (const move of played) state = applyMove(state, move);
  const settings = levelSettings(level);
  const found = search(state, { ...settings, timeMs: Math.min(timeMs, settings.timeMs) });
  const { from, to, promotion, drop } = found ? found.move : {};
  postMessage({ id, move: found && { from, to, promotion, drop }, score: found ? found.score : 0 });
};

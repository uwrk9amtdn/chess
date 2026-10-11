// Finds the games. Every folder in the games directory that has a
// server/index.js is a game; nothing else needs to be registered.

import path from 'node:path';
import { readdir, access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Returns a Map of game id -> game module, in alphabetical order.
export async function loadGames(dir) {
  const games = new Map();
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'server', 'index.js');
    try {
      await access(file);
    } catch {
      continue;
    }
    const game = (await import(pathToFileURL(file).href)).default;
    // The id is also the folder name in URLs, so the two must agree.
    if (game.meta.id !== entry.name) {
      throw new Error(`Game in "${entry.name}" declares the id "${game.meta.id}"; they must match.`);
    }
    games.set(game.meta.id, game);
  }
  return games;
}

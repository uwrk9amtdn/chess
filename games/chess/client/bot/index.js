// The bot's side of a game against the computer. The server runs the match
// as it does between two people; this plays the bot's seat from the browser
// of the player facing it, by sending that seat's actions marked `bot`.

import { variants, STOCKFISH_VARIANTS } from '../../shared/variants.js';
import { createStockfish } from './stockfish.js';

// A move is not sent sooner than this, so the bot does not answer in a blink.
const MIN_DELAY_MS = 400;
// A draw is only accepted this many moves (by either side) into the game.
const DRAW_AFTER_PLIES = 40;

// The search in shared/search.js on its own thread, with the same interface
// as Stockfish.
function createSearch() {
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const waiting = new Map(); // id -> { resolve, reject }
  let nextId = 0;
  worker.onmessage = ({ data }) => {
    waiting.get(data.id)?.resolve(data);
    waiting.delete(data.id);
  };
  worker.onerror = (e) => {
    for (const { reject } of waiting.values()) reject(new Error(e.message));
    waiting.clear();
  };
  return {
    think: (request) => new Promise((resolve, reject) => {
      waiting.set(nextId, { resolve, reject });
      worker.postMessage({ ...request, id: nextId++ });
    }),
    stop() {},
    destroy: () => worker.terminate(),
  };
}

// The seat this browser plays for, or null: the bot's seat as seen by the
// player it faces. Spectators and finished games have nobody to play for.
function botSeat(game) {
  if (game.over || game.you === null || !game.bots) return null;
  const seat = game.bots.findIndex((bot, s) => bot && s !== game.you);
  return seat === -1 ? null : seat;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns { update(snapshot), destroy() }; `update` takes every snapshot the
// game screen gets.
export function createBot(ctx) {
  const engines = {}; // started when first needed
  let game = null;
  let thinking = null; // "<id>:<ply>" of the position being thought about
  let sent = null; // the position a move was last sent for
  let retried = null; // the position Stockfish's move was refused in
  let answered = null; // the position a draw offer was answered in
  let score = 0; // what the bot last thought of its position
  let stockfishFailed = false;
  let destroyed = false;

  function engine(name) {
    engines[name] ||= name === 'stockfish' ? createStockfish() : createSearch();
    return engines[name];
  }

  const keyOf = (g) => `${g.id}:${g.played.length}`;
  const send = (action) => ctx.send({ ...action, bot: true });

  async function play(seat, useStockfish) {
    const asked = game;
    const key = keyOf(asked);
    const variant = variants[asked.variant];
    const left = asked.clocks[variant.seats[seat].clock];
    const request = {
      variant: asked.variant,
      start: asked.start,
      played: asked.played,
      level: asked.bots[seat].level,
      // A thirtieth of what is left, and half of what each move adds.
      timeMs: left / 30 + asked.incrementMs / 2,
    };
    const startedAt = performance.now();
    let found;
    try {
      found = await engine(useStockfish ? 'stockfish' : 'search').think(request);
    } catch (err) {
      if (destroyed) return;
      if (!useStockfish) throw err;
      console.error(err);
      stockfishFailed = true;
      ctx.toast('Stockfish could not be loaded; a simpler bot plays instead.');
      found = await engine('search').think(request);
    }
    await delay(Math.min(MIN_DELAY_MS, left / 40) - (performance.now() - startedAt));
    // The game may have ended or gone elsewhere while the bot was thinking.
    if (destroyed || !found.move || !game || game.over || keyOf(game) !== key) return;
    score = found.score;
    sent = key;
    send({ action: 'move', ...found.move });
  }

  return {
    update(snapshot) {
      // The same snapshot again means the server refused something.
      const refused = snapshot === game;
      game = snapshot;
      const seat = botSeat(game);
      if (seat === null) {
        thinking = null;
        engines.stockfish?.stop();
        return;
      }
      const key = keyOf(game);
      if (game.drawOffer !== null && game.drawOffer !== seat && answered !== key) {
        answered = key;
        send({ action: game.played.length >= DRAW_AFTER_PLIES && score <= 0 ? 'acceptDraw' : 'declineDraw' });
      }
      if (variants[game.variant].turnOrder[game.state.turn] !== seat) return;
      let useStockfish = STOCKFISH_VARIANTS.includes(game.variant) && !stockfishFailed;
      if (thinking === key) {
        // Should Stockfish's move ever be refused, the other bot has a go.
        if (!refused || sent !== key || !useStockfish || retried === key) return;
        retried = key;
        useStockfish = false;
      }
      thinking = key;
      play(seat, useStockfish).catch(console.error);
    },
    destroy() {
      destroyed = true;
      for (const e of Object.values(engines)) e.destroy();
    },
  };
}

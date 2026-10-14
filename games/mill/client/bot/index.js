// The bot's side of a game against the computer. The server runs the match
// as it does between two people; this plays the bot's seat from the browser
// of the player facing it, by sending that seat's actions marked `bot`.

// A move is not sent sooner than this, so the bot does not answer in a blink.
const MIN_DELAY_MS = 400;
// A draw is only accepted this many moves (by either side) into the game,
// and only when the bot does not think it is ahead.
const DRAW_AFTER_PLIES = 30;

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
  let worker = null; // started when first needed
  const waiting = new Map(); // id -> resolve
  let nextId = 0;
  let game = null;
  let thinking = null; // the position being thought about
  let answered = null; // the position a draw offer was answered in
  let granted = null; // the position a takeback was granted in
  let score = 0; // what the bot last thought of its position
  let destroyed = false;

  function think(request) {
    if (!worker) {
      worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        waiting.get(data.id)?.(data);
        waiting.delete(data.id);
      };
      worker.onerror = (e) => console.error(e.message);
    }
    return new Promise((resolve) => {
      waiting.set(nextId, resolve);
      worker.postMessage({ ...request, id: nextId++ });
    });
  }

  // A takeback brings back a number of moves that was seen before.
  const keyOf = (g) => `${g.id}:${g.takebacks}:${g.played.length}`;
  const send = (action) => ctx.send({ ...action, bot: true });

  async function play(seat) {
    const asked = game;
    const key = keyOf(asked);
    const startedAt = performance.now();
    const found = await think({
      variant: asked.options.variant,
      played: asked.played,
      level: asked.bots[seat].level,
      // A thirtieth of what is left, and half of what each move adds.
      ms: asked.clocks[seat] / 30 + asked.incrementMs / 2,
    });
    await delay(MIN_DELAY_MS - (performance.now() - startedAt));
    // The game may have ended or gone elsewhere while the bot was thinking.
    if (destroyed || !game || game.over || keyOf(game) !== key) return;
    // Nor is a move sent that is about to be taken back.
    if (game.takebackOffer !== null) return;
    score = found.score;
    send({ action: 'move', ...found.move });
  }

  return {
    update(snapshot) {
      game = snapshot;
      const seat = botSeat(game);
      if (seat === null) {
        thinking = null;
        return;
      }
      const key = keyOf(game);
      if (game.drawOffer !== null && game.drawOffer !== seat && answered !== key) {
        answered = key;
        send({ action: game.played.length >= DRAW_AFTER_PLIES && score <= 0 ? 'acceptDraw' : 'declineDraw' });
      }
      // The player may always have their move back.
      if (game.takebackOffer !== null && game.takebackOffer !== seat) {
        if (granted !== key) {
          granted = key;
          send({ action: 'acceptTakeback' });
        }
        return;
      }
      if (game.turn !== seat || thinking === key) return;
      thinking = key;
      play(seat).catch(console.error);
    },
    destroy() {
      destroyed = true;
      worker?.terminate();
    },
  };
}

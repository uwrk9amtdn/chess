// The bot's side of a game against the computer. The server runs the match
// as it does between two people; this plays the bot's seat from the browser
// of the player facing it, by sending that seat's actions marked `bot`.

// A move is not sent sooner than this, so the bot does not answer in a blink.
const MIN_DELAY_MS = 400;

// The seat this browser plays for, or null: the bot's seat as seen by the
// player it faces. Spectators and finished games have nobody to play for.
function botSeat(game) {
  if (game.over || game.you === null || !game.bots) return null;
  const seat = game.bots.findIndex((bot, s) => bot && s !== game.you);
  return seat === -1 ? null : seat;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long the bot may think, from what is left on its clock.
function thinkingTime(game, seat) {
  const clock = game.clocks[seat];
  const { options, periodMs } = game;
  if (options.clock !== 'byoyomi') return clock.ms / 30 + options.increment * 500;
  if (clock.byo) return periodMs * 0.4;
  return clock.ms / 30 + periodMs * 0.2;
}

// Returns { update(snapshot), destroy() }; `update` takes every snapshot the
// game screen gets.
export function createBot(ctx) {
  let worker = null; // started when first needed
  const waiting = new Map(); // id -> resolve
  let nextId = 0;
  let game = null;
  let thinking = null; // the position being thought about
  let sent = null; // the position a move was last sent for
  let granted = null; // the position a takeback was granted in
  let agreed = null; // the marking of dead stones the bot accepted
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

  // A takeback brings back a number of moves that was seen before, and
  // resuming play after both passed brings back the same moves.
  const keyOf = (g) => `${g.id}:${g.takebacks}:${g.played.length}:${g.passes}:${g.scoring ? 'counting' : 'playing'}`;
  const send = (action) => ctx.send({ ...action, bot: true });

  async function play(seat) {
    const asked = game;
    const key = keyOf(asked);
    const startedAt = performance.now();
    const found = await think({
      size: asked.options.size,
      handicap: asked.options.handicap,
      komi: asked.komi,
      played: asked.played,
      passes: asked.passes,
      level: asked.bots[seat].level,
      timeMs: thinkingTime(asked, seat),
    });
    await delay(MIN_DELAY_MS - (performance.now() - startedAt));
    // The game may have ended or gone elsewhere while the bot was thinking.
    if (destroyed || !game || game.over || keyOf(game) !== key) return;
    // Nor is a move sent that is about to be taken back.
    if (game.takebackOffer !== null) return;
    sent = key;
    send(found.move.pass ? { action: 'pass' } : { action: 'move', point: found.move.point });
  }

  return {
    update(snapshot) {
      // The same snapshot again means the server refused something.
      const refused = snapshot === game;
      game = snapshot;
      const seat = botSeat(game);
      if (seat === null) {
        thinking = null;
        return;
      }
      const key = keyOf(game);
      // While counting, the bot goes along with whatever its opponent accepts.
      if (game.scoring) {
        const marking = `${key}:${game.scoring.dead}`;
        if (!game.scoring.accepted[game.you]) agreed = null;
        else if (!game.scoring.accepted[seat] && agreed !== marking) {
          agreed = marking;
          send({ action: 'acceptScore' });
        }
        return;
      }
      // The player may always have their move back.
      if (game.takebackOffer !== null && game.takebackOffer !== seat) {
        if (granted !== key) {
          granted = key;
          send({ action: 'acceptTakeback' });
        }
        return;
      }
      if (game.turn !== seat) return;
      if (thinking === key) {
        // Should its move ever be refused, the bot passes rather than hang.
        if (refused && sent === key) {
          sent = null;
          send({ action: 'pass' });
        }
        return;
      }
      thinking = key;
      play(seat).catch(console.error);
    },
    destroy() {
      destroyed = true;
      worker?.terminate();
    },
  };
}

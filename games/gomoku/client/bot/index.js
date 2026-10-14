// The bot's side of a game against the computer. The server runs the match
// as it does between two people; this plays the bot's seat from the browser
// of the player facing it, by sending that seat's actions marked `bot`.

import { BLACK } from '../../shared/rules.js';

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

// Returns { update(snapshot), destroy() }; `update` takes every snapshot the
// game screen gets.
export function createBot(ctx) {
  let worker = null; // started when first needed
  const waiting = new Map(); // id -> resolve
  let nextId = 0;
  let game = null;
  let thinking = null; // the position being thought about
  let granted = null; // the position a takeback was granted in
  let opening = null; // { id, points }: the Swap2 stones the bot lays down
  let destroyed = false;

  function ask(request) {
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

  // A takeback brings back a number of stones that was seen before, and a
  // Swap2 choice changes nothing on the board.
  const keyOf = (g) => `${g.id}:${g.takebacks}:${g.played.length}:${g.step}`;
  const send = (action) => ctx.send({ ...action, bot: true });

  // Works out the bot's action for the snapshot it was asked in.
  async function decide(asked, seat) {
    const request = {
      size: asked.options.size,
      variant: asked.options.variant,
      played: asked.played,
      level: asked.bots[seat].level,
      // A thirtieth of what is left, and half of what each move adds.
      ms: asked.clocks[seat] / 30 + asked.incrementMs / 2,
    };
    if (asked.step === 'place3') {
      if (opening?.id !== asked.id) opening = { id: asked.id, points: (await ask({ ...request, kind: 'opening' })).points };
      return { action: 'move', point: opening.points[asked.played.length] };
    }
    if (asked.step === 'choose' || asked.step === 'choose2') {
      const { colour } = await ask({ ...request, kind: 'colour' });
      return { action: 'choose', choice: colour === BLACK ? 'black' : 'white' };
    }
    return { action: 'move', point: (await ask({ ...request, kind: 'move' })).point };
  }

  async function act(seat) {
    const asked = game;
    const key = keyOf(asked);
    const startedAt = performance.now();
    const action = await decide(asked, seat);
    await delay(MIN_DELAY_MS - (performance.now() - startedAt));
    // The game may have ended or gone elsewhere while the bot was thinking.
    if (destroyed || !game || game.over || keyOf(game) !== key) return;
    // Nor is a move sent that is about to be taken back.
    if (game.takebackOffer !== null) return;
    send(action);
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
      // The player may always have their move back.
      if (game.takebackOffer !== null && game.takebackOffer !== seat) {
        if (granted !== key) {
          granted = key;
          send({ action: 'acceptTakeback' });
        }
        return;
      }
      if (game.actor !== seat || thinking === key) return;
      thinking = key;
      act(seat).catch(console.error);
    },
    destroy() {
      destroyed = true;
      worker?.terminate();
    },
  };
}

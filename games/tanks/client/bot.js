// The bot's side of a game against the computer. The server runs the match
// as it does between two people; this plays the bot's seat from the browser
// of the player facing it, by sending that seat's inputs marked `bot`. The
// thinking is in shared/bot.js; it is quick enough to run on the page.

import { createBrain } from '../shared/bot.js';

// How often the brain is asked whether it has something new to do.
const POLL_MS = 50;

// The seat this browser plays for, or null: the bot's seat as seen by the
// player it faces. Spectators and finished games have nobody to play for.
function botSeat(game) {
  if (game.over || game.you === null || !game.bots) return null;
  const seat = game.bots.findIndex((bot, s) => bot && s !== game.you);
  return seat === -1 ? null : seat;
}

// Returns { update(snapshot), destroy() }; `update` takes every snapshot the
// game screen gets.
export function createBot(ctx) {
  let game = null;
  let brain = null; // { id, decide } for the match being played
  let timer = null;

  function think() {
    const seat = game && botSeat(game);
    if (seat === null || game.phase !== 'playing' || game.paused) return;
    const decision = brain.decide(game, seat, performance.now());
    if (!decision) return;
    ctx.send({ action: 'input', ...decision.input, bot: true });
    if (decision.fire) ctx.send({ action: 'fire', bot: true });
  }

  return {
    update(snapshot) {
      game = snapshot;
      const seat = botSeat(game);
      if (seat === null) {
        clearInterval(timer);
        timer = null;
        return;
      }
      // A rematch is a new match, with a fresh bot.
      if (!brain || brain.id !== game.id) brain = { id: game.id, ...createBrain(game.bots[seat].level) };
      timer ??= setInterval(think, POLL_MS);
    },
    destroy() {
      clearInterval(timer);
    },
  };
}

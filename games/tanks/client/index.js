// Tanks in the browser: the options in the invitation dialog and the game
// screen. The battle comes from the server as snapshots, many a second; the
// arena draws them and sends the player's controls. See games/README.md.

import { MAP_H, MAP_W, MAX_HP, ROUND_CHOICES, TANK_COLOURS } from '../shared/constants.js';
import { WALLS } from '../shared/map.js';
import { BOT_LEVELS } from '../shared/bot.js';
import { el, load, save, loadStylesheet } from '/js/kit/dom.js';
import { slider } from '/js/kit/setup.js';
import { createArena } from './arena.js';
import { createBot } from './bot.js';

loadStylesheet(new URL('/js/kit/kit.css', import.meta.url));
loadStylesheet(new URL('./tanks.css', import.meta.url));

const SETUP_KEY = 'tanks.setup';
const CHAT_KEY = 'tanks.chat';
const CHAT_PHRASES = { GG: 'Good game', WP: 'Well played', TY: 'Thank you', GTG: "I've got to go", BYE: 'Bye!' };
const CHAT_MAX_LENGTH = 140;
const LEVELS = Array.from({ length: BOT_LEVELS }, (_, i) => i + 1);

const needed = (rounds) => (rounds + 1) / 2;
const describeOptions = ({ rounds }) => (rounds === 1 ? 'One round' : `Best of ${rounds}`);

// What was last sent from the setup is offered again.
function rememberedSetup() {
  const setup = { rounds: 3, level: 3 };
  const saved = load(SETUP_KEY) || {};
  if (ROUND_CHOICES.includes(saved.rounds)) setup.rounds = saved.rounds;
  if (LEVELS.includes(saved.level)) setup.level = saved.level;
  return setup;
}

// One tile per length of match; clicking one sends it off. Against the
// computer its level comes first.
function tanksSetup(container, submit, bot) {
  const setup = rememberedSetup();
  const tiles = el('div', { className: 'kitTimes tanksTiles' }, ...ROUND_CHOICES.map((rounds) => el('button', {
    type: 'button',
    className: 'kitTimeTile',
    onclick: () => {
      setup.rounds = rounds;
      save(SETUP_KEY, setup);
      if (bot) submit({ options: { rounds }, bot: { level: setup.level }, seat: null });
      else submit({ rounds });
    },
  }, el('strong', { textContent: describeOptions({ rounds }) }),
  el('span', { textContent: rounds === 1 ? 'Sudden death' : `First to ${needed(rounds)}` }))));
  const about = el('p', {
    className: 'kitMuted kitAbout',
    textContent: 'Each tank takes three hits. Shells bounce off one wall, and can hit the tank that fired them on the way back.',
  });
  if (bot) container.append(el('div', { className: 'kitOpponent' }, slider(setup, 'level', 'Level', LEVELS).node));
  container.append(about, tiles);
}

const inviteForm = (container, submit) => tanksSetup(container, submit, false);
const botForm = (container, submit) => tanksSetup(container, submit, true);

// { score: '2-1', how: 'bob resigned', text: 'bob resigned • alice is victorious' }
function resultOf({ players, over }) {
  const score = (over.score ?? [0, 0]).join('-');
  const winner = over.winner === null ? null : players[over.winner];
  const loser = over.winner === null ? null : players[1 - over.winner];
  const how = {
    rounds: () => `${winner} won`,
    limit: () => (winner ? `${winner} won on rounds` : 'Round limit reached'),
    resign: () => `${loser} resigned`,
    abandoned: () => `${loser} left the game`,
  }[over.reason]();
  return { score, how, text: winner ? `${how} • ${winner} is victorious` : `${how} • Draw` };
}

// "2-1 • alice won", for lists of finished games.
function describeResult(match) {
  const { score, how } = resultOf(match);
  return `${score} • ${how}`;
}

// A small row of armour pips in a tank's colour.
function pips(hp, colour) {
  return el('span', { className: 'tanksPips' }, ...Array.from({ length: MAX_HP }, (_, k) => el('i', {
    style: k < hp ? `background:${colour}` : '',
  })));
}

// How one round went, in a few words.
function roundText(players, { winner, reason }) {
  if (winner === null) return reason === 'time' ? 'Time up, even' : 'Both destroyed';
  return reason === 'time' ? `${players[winner]}, on armour` : players[winner];
}

function mount(container, ctx) {
  let game = null;
  let shownKey = null; // what the panel was last drawn from
  const bot = createBot(ctx);

  // ---- the frame: the arena, and beside it (under it on a phone) the score,
  // the status and the chat ----

  const arenaHost = el('div', { className: 'tanksArena' });
  const help = el('p', {
    className: 'kitMuted tanksHelp',
    textContent: matchMedia('(pointer: coarse)').matches
      ? 'Touch the left half to drive, the right half to aim and fire. Sideways, the arena is bigger.'
      : 'WASD or arrows to drive • mouse to aim • click or Space to fire',
  });
  const board = el('div', { className: 'kitCard tanksBoard' });
  const status = el('div', { className: 'kitStatus' });
  const actions = el('div', { className: 'kitActions' });
  const rounds = el('ol', { className: 'tanksRounds' });
  const info = el('div', { className: 'tanksInfo kitMuted' });

  const chatToggle = el('input', { type: 'checkbox', checked: load(CHAT_KEY) !== false, title: 'Show the chat' });
  const chatList = el('ul', { className: 'kitChatLog' });
  const chatInput = el('input', { maxLength: CHAT_MAX_LENGTH, autocomplete: 'off', placeholder: 'Please be nice in the chat!' });
  const chatForm = el('form', {}, chatInput);
  const chatBody = el('div', { className: 'kitChatBody' }, chatList, chatForm, el('div', { className: 'kitChatQuick' },
    ...Object.entries(CHAT_PHRASES).map(([short, phrase]) => el('button', {
      type: 'button', textContent: short, title: phrase, onclick: () => ctx.sendChat(phrase),
    }))));
  const chatCard = el('div', { className: 'kitCard kitChat' },
    el('div', { className: 'kitChatHead' }, el('label', {}, 'Chat room', chatToggle)), chatBody);
  let chatMessages = [];
  const renderChat = () => {
    chatBody.hidden = !chatToggle.checked;
    chatList.replaceChildren(...chatMessages.map((m) => el('li', {}, el('strong', { textContent: m.from }), ` ${m.text}`)));
    chatList.scrollTop = chatList.scrollHeight;
  };
  chatToggle.addEventListener('change', () => {
    save(CHAT_KEY, chatToggle.checked);
    renderChat();
  });
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text) ctx.sendChat(text);
    chatInput.value = '';
    // Back to the battle: the keys drive the tank again.
    chatInput.blur();
  });

  container.replaceChildren(el('div', { className: 'tanks' },
    el('div', { className: 'tanksMain' }, arenaHost, help),
    el('div', { className: 'tanksSide' },
      el('div', { className: 'kitCard tanksPanel' }, board, info, rounds, status, actions),
      chatCard)));

  const arena = createArena(arenaHost, { send: (action) => ctx.send(action), banner });

  // The words across the arena between the fighting.
  function banner(g) {
    if (g.over) {
      const result = resultOf(g);
      return { big: g.over.winner === null ? 'Draw' : `${g.players[g.over.winner]} wins!`, small: result.how };
    }
    if (g.paused) {
      const away = g.players.find((_, seat) => !g.connected[seat]);
      return { big: 'Paused', small: `Waiting for ${away} to come back…` };
    }
    if (g.phase === 'roundOver') {
      const last = g.moves[g.moves.length - 1];
      return { big: last.winner === null ? 'Even' : `${g.players[last.winner]} takes it`, small: `${g.score.join(' – ')}` };
    }
    if (g.phase === 'countdown') return { big: '', small: g.moves.length ? `Round ${g.moves.length + 1}` : 'Get ready!' };
    return null;
  }

  // Sounds for whatever changed between two snapshots of one match.
  function announce(prev, next) {
    if (!prev || prev.id !== next.id) return;
    const seen = new Set(prev.bullets.map((b) => b.id));
    if (next.bullets.some((b) => !seen.has(b.id))) ctx.play('move');
    next.tanks.forEach((t, seat) => {
      const was = prev.tanks[seat].hp;
      if (t.hp < was) ctx.play(t.hp ? 'capture' : 'explosion');
    });
    if (next.phase === 'playing' && prev.phase !== 'playing') ctx.play('check');
    if (next.over && !prev.over) ctx.play('end', 0.4);
  }

  // The panel only changes now and then, so it is drawn again only then.
  function render() {
    const key = JSON.stringify([game.id, game.phase, game.paused, game.score, game.tanks.map((t) => t.hp),
      game.connected, game.spectators, game.over, game.moves.length]);
    if (key === shownKey) return;
    shownKey = key;
    const live = !game.over;
    const target = needed(game.options.rounds);

    board.replaceChildren(...game.players.map((name, seat) => el('div', { className: 'tanksRow' },
      el('span', { className: 'tanksSwatch', style: `background:${TANK_COLOURS[seat]}` }),
      el('span', { className: `dot ${game.connected[seat] ? 'online' : 'offline'}`, hidden: !live || Boolean(game.bots?.[seat]) }),
      el('span', { className: 'tanksName', textContent: name + (seat === game.you ? ' (you)' : '') }),
      pips(game.tanks[seat].hp, TANK_COLOURS[seat]),
      el('span', { className: 'tanksWins', title: `${game.score[seat]} of ${target} rounds won` },
        ...Array.from({ length: target }, (_, k) => el('i', { className: k < game.score[seat] ? 'won' : '' }))))));

    const round = Math.min(game.moves.length + (game.phase === 'roundOver' || game.over ? 0 : 1), 2 * game.options.rounds);
    info.replaceChildren(
      `${describeOptions(game.options)}${round ? ` • Round ${round}` : ''}`,
      ...(game.spectators && live ? [el('span', { textContent: ` • ${game.spectators} watching` })] : []));
    rounds.replaceChildren(...game.moves.map((r) => el('li', { textContent: roundText(game.players, r) })));
    rounds.hidden = !game.moves.length;

    const result = game.over && resultOf(game);
    if (result) status.replaceChildren(el('strong', { textContent: result.score }), el('em', { textContent: result.text }));
    else status.replaceChildren(banner(game)?.small || (game.you === null ? 'Watching' : 'Fight!'));
    status.classList.toggle('over', !live);

    actions.replaceChildren();
    if (live && game.you !== null) {
      actions.append(el('button', {
        textContent: 'Resign',
        className: 'danger',
        onclick: () => {
          if (confirm('Resign this match?')) ctx.send({ action: 'resign' });
        },
      }));
    }
    help.hidden = game.you === null || !live;
    // A bot has nothing to say, and a spectator cannot talk.
    chatCard.hidden = game.you === null || Boolean(game.bots?.some(Boolean));
  }

  return {
    update(snapshot) {
      // The same snapshot again means "redraw", e.g. after a refused action.
      if (snapshot !== game) announce(game, snapshot);
      game = snapshot;
      arena.update(game);
      render();
      bot.update(game);
    },
    chat(messages) {
      // One more message than before is a new one; anything else is the log.
      const added = messages.length === chatMessages.length + 1 ? messages[messages.length - 1] : null;
      chatMessages = messages.slice();
      if (added && chatToggle.checked && game && added.from !== game.players[game.you]) ctx.play('notify');
      renderChat();
    },
    destroy() {
      bot.destroy();
      arena.destroy();
      container.replaceChildren();
    },
  };
}

// The arena with the score across it and each tank's armour, for lists of
// games. Where the tanks are is not sent, so they are not drawn.
function preview(container, { score, hp }) {
  const SVG = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };
  const svg = make('svg', { viewBox: `0 0 ${MAP_W} ${MAP_H}`, class: 'tanksThumb' });
  for (const w of WALLS) svg.append(make('rect', { x: w.x, y: w.y, width: w.w, height: w.h, class: 'tanksThumbWall' }));
  score.forEach((s, seat) => {
    const x = MAP_W / 2 + (seat ? 250 : -250);
    const text = make('text', { x, y: MAP_H / 2 + 40, 'text-anchor': 'middle', fill: TANK_COLOURS[seat], class: 'tanksThumbScore' });
    text.textContent = s;
    svg.append(text);
    for (let k = 0; k < MAX_HP; k++) {
      svg.append(make('rect', {
        x: x - 75 + k * 52, y: MAP_H / 2 + 110, width: 46, height: 22, fill: k < hp[seat] ? TANK_COLOURS[seat] : '#3a3f4b',
      }));
    }
  });
  container.replaceChildren(svg);
}

export default { inviteForm, botForm, describeOptions, describeResult, preview, mount };

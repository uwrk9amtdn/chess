// The frame of a game screen, as chess has it, for games that want the same
// look: game details and chat on the left, the board in the middle, and on
// the right the clocks as tabs on a panel with the players, the moves, the
// buttons to step through them, the status and the actions. On a narrow
// screen everything stacks under the board.
//
// The game fills in the board, the details, the status and the actions, and
// tells the frame about players, clocks and moves; the frame does the rest.

import { el, icon, capitalise, loadStylesheet, load, save } from './dom.js';

loadStylesheet(new URL('./kit.css', import.meta.url));

// A step button that is held down starts repeating after the first of these,
// once every second one.
const HOLD_DELAY_MS = 400;
const HOLD_REPEAT_MS = 90;
const CHAT_PHRASES = { GG: 'Good game', WP: 'Well played', TY: 'Thank you', GTG: "I've got to go", BYE: 'Bye!' };
const CHAT_MAX_LENGTH = 140;
// On a narrow screen the board shrinks so the rest fits under it, but to no
// less than this part of the width; past that the page scrolls.
const MIN_FIT = 0.7;
const NARROW = matchMedia('(max-width: 860px)');
const NAV_ICONS = {
  first: 'M6 5h2v14H6zM20 5v14l-10-7z',
  prev: 'M17 5v14L7 12z',
  next: 'M7 5v14l10-7z',
  last: 'M16 5h2v14h-2zM4 5v14l10-7z',
};

// A small round stone in the text: 0 Black, 1 White, null not yet known.
export function stoneIcon(colour) {
  return el('span', { className: `kitStoneIcon ${colour === 0 ? 'b' : colour === 1 ? 'w' : 'unknown'}` });
}

// A button for the actions row that sends `action` to the match.
export function actionButton(ctx, textContent, action, props = {}) {
  return el('button', { textContent, onclick: () => ctx.send({ action }), ...props });
}

// `chatKey` is where the player's choice to show the chat is kept, and
// `onGo(ply)` is called to look at the position after `ply` moves; it may be
// out of range, for the game to clamp.
export function createScreen(container, ctx, { chatKey, onGo }) {
  // What is shown for one player beside the board: top is the opponent. On a
  // narrow screen the stylesheet puts each player's on a line above or below
  // the board, which is what `where` is for. `extra` is for a few words,
  // such as the stones taken.
  const side = (where) => ({
    extra: el('div', { className: `kitExtra ${where}` }),
    clock: el('div', { className: `kitClock ${where}` }, el('span', { className: 'time' }), el('span', { className: 'periods' })),
    bar: el('div', { className: `kitBar ${where}` }, el('span')),
    player: el('div', { className: `kitPlayer ${where}` },
      el('span', { className: 'dot' }), stoneIcon(null), el('span', { className: 'name' })),
  });
  const top = side('top');
  const bottom = side('bottom');
  const board = el('div');
  const nav = Object.fromEntries(Object.entries(NAV_ICONS).map(([name, path]) => {
    const button = el('button', { type: 'button', title: `${capitalise(name)} move` }, icon(path));
    return [name, button];
  }));
  const moves = el('div', { className: 'kitMoves' });
  const status = el('div', { className: 'kitStatus' });
  const actions = el('div', { className: 'kitActions' });
  const info = el('div', { className: 'kitCard kitInfo' });

  const chatToggle = el('input', { type: 'checkbox', checked: load(chatKey) !== false, title: 'Show the chat' });
  const chatList = el('ul', { className: 'kitChatLog' });
  const chatInput = el('input', {
    maxLength: CHAT_MAX_LENGTH, autocomplete: 'off', placeholder: 'Please be nice in the chat!',
  });
  const chatForm = el('form', {}, chatInput);
  const chatQuick = el('div', { className: 'kitChatQuick' },
    ...Object.entries(CHAT_PHRASES).map(([short, phrase]) => el('button', {
      type: 'button',
      textContent: short,
      title: phrase,
      onclick: () => ctx.sendChat(phrase),
    })));
  const chatBody = el('div', { className: 'kitChatBody' }, chatList, chatForm, chatQuick);
  // On a narrow screen the chat is put away: a button in the platform's bar
  // opens it over the whole page, and shows when something new was said.
  const chatOpen = el('button', { type: 'button', className: 'kitChatOpen', textContent: 'Chat', hidden: true });
  const chatClose = el('button', { type: 'button', className: 'kitChatClose', textContent: 'Close' });
  const chatCard = el('div', { className: 'kitCard kitChat' },
    el('div', { className: 'kitChatHead' }, el('label', {}, 'Chat room', chatToggle), chatClose), chatBody);
  ctx.toolbar?.append(chatOpen);

  const table = el('div', { className: 'kitTable' }, board);
  const root = el('div', { className: 'kit' });
  root.append(
    el('div', { className: 'kitSide' }, info, chatCard),
    table,
    el('div', { className: 'kitControls' },
      top.extra, top.clock,
      el('div', { className: 'kitCard kitPanel' },
        top.bar, top.player,
        el('div', { className: 'kitNav' }, nav.first, nav.prev, nav.next, nav.last),
        moves, status, actions,
        bottom.player, bottom.bar),
      bottom.clock, bottom.extra));
  container.replaceChildren(root);

  // ---- stepping through the moves ----

  let ply = 0;
  let total = 0;
  nav.first.onclick = () => onGo(0);
  nav.last.onclick = () => onGo(total);
  // One step back or forward, and more of them for as long as the button is
  // held down.
  let holdTimer = null;
  const release = () => clearTimeout(holdTimer);
  for (const [button, by] of [[nav.prev, -1], [nav.next, 1]]) {
    const step = () => onGo(ply + by);
    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      release();
      step();
      const again = () => {
        if (button.disabled) return;
        step();
        holdTimer = setTimeout(again, HOLD_REPEAT_MS);
      };
      holdTimer = setTimeout(again, HOLD_DELAY_MS);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, release);
    // A long press must not bring up the browser's menu instead.
    button.addEventListener('contextmenu', (e) => e.preventDefault());
    // The pointer has stepped already; this is for the keyboard.
    button.addEventListener('click', (e) => {
      if (e.detail === 0) step();
    });
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, dialog')) return;
    const target = { ArrowLeft: ply - 1, ArrowRight: ply + 1, ArrowUp: 0, ArrowDown: total }[e.key];
    if (target === undefined) return;
    e.preventDefault();
    onGo(target);
  }
  document.addEventListener('keydown', onKey);

  // ---- fitting the board ----

  // On a narrow screen everything is stacked under the board, which is as
  // wide as the screen; on a short one the board gives up just enough of its
  // size for the rest to fit without scrolling.
  function fitBoard() {
    table.style.width = '';
    if (!NARROW.matches) return;
    const page = document.scrollingElement;
    const over = page.scrollHeight - page.clientHeight;
    if (over <= 0) return;
    const width = table.getBoundingClientRect().width;
    table.style.width = `${Math.max(width * MIN_FIT, width - over)}px`;
  }
  // Measured just before the next paint, once the platform has finished
  // changing the page around the game too (its header, the list it hides).
  let fitFrame = 0;
  function fit() {
    cancelAnimationFrame(fitFrame);
    fitFrame = requestAnimationFrame(fitBoard);
  }
  window.addEventListener('resize', fit);

  // ---- chat ----

  let chatMessages = [];
  function renderChat() {
    chatBody.hidden = !chatToggle.checked;
    chatList.replaceChildren(...chatMessages.map((m) => el('li', {}, el('strong', { textContent: m.from }), ` ${m.text}`)));
    chatList.scrollTop = chatList.scrollHeight;
  }
  function showChatSheet(open) {
    root.classList.toggle('chatOpen', open);
    if (open) chatOpen.classList.remove('unread');
    renderChat();
  }
  chatOpen.onclick = () => showChatSheet(true);
  chatClose.onclick = () => showChatSheet(false);
  chatToggle.addEventListener('change', () => {
    save(chatKey, chatToggle.checked);
    renderChat();
  });
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text) ctx.sendChat(text);
    chatInput.value = '';
  });
  renderChat();

  return {
    root, board, info, status, actions, top, bottom,

    // `connected` is null once it no longer matters (the game is over).
    setPlayer(where, { name, colour, connected }) {
      const dot = where.player.querySelector('.dot');
      dot.className = `dot ${connected ? 'online' : 'offline'}`;
      dot.hidden = connected === null;
      where.player.querySelector('.kitStoneIcon').replaceWith(stoneIcon(colour));
      where.player.querySelector('.name').textContent = name;
    },

    // `time` is what the clock shows, `fill` how much of the bar under the
    // player is full (0 to 1), and `label` a few words beside the time, such
    // as byo-yomi's periods.
    setClock(where, { time, label = null, active, low, fill }) {
      where.clock.querySelector('.time').textContent = time;
      const periods = where.clock.querySelector('.periods');
      periods.hidden = label === null;
      periods.textContent = label ?? '';
      where.clock.classList.toggle('active', active);
      where.clock.classList.toggle('low', low);
      where.bar.firstChild.style.width = `${Math.min(100, Math.max(0, fill) * 100)}%`;
    },

    // Two moves a row, numbered by the first of them; `className(name)` may
    // style some, such as passes.
    setMoves(names, shownPly, className = () => '') {
      const cells = [];
      names.forEach((name, i) => {
        if (i % 2 === 0) cells.push(el('span', { className: 'index', textContent: i + 1 }));
        cells.push(el('button', {
          type: 'button',
          className: `${i + 1 === shownPly ? 'active' : ''} ${className(name)}`.trim(),
          textContent: name,
          onclick: () => onGo(i + 1),
        }));
      });
      moves.replaceChildren(...cells);
      // Scroll only as far as needed to keep the move being shown in sight:
      // down the list, or along it where a narrow screen has it in one row.
      const active = moves.querySelector('.active');
      if (!active) moves.scrollTop = moves.scrollLeft = 0;
      else {
        const below = active.offsetTop + active.offsetHeight;
        moves.scrollTop = Math.max(below - moves.clientHeight, Math.min(moves.scrollTop, active.offsetTop));
        const right = active.offsetLeft + active.offsetWidth;
        moves.scrollLeft = Math.max(right - moves.clientWidth, Math.min(moves.scrollLeft, active.offsetLeft));
      }
    },

    // Which position is shown, out of how many, for the step buttons.
    setNav(shownPly, count) {
      ply = shownPly;
      total = count;
      nav.first.disabled = nav.prev.disabled = ply === 0;
      nav.next.disabled = nav.last.disabled = ply === total;
    },

    // A bot has nothing to say, and a spectator cannot talk.
    setChatAvailable(available) {
      chatCard.hidden = chatOpen.hidden = !available;
    },

    // The whole conversation; `me` is our own name, so that only what others
    // say makes a sound.
    chat(messages, me) {
      // One more message than before is a new one; anything else is the log.
      const added = messages.length === chatMessages.length + 1 ? messages[messages.length - 1] : null;
      chatMessages = messages.slice();
      if (added && chatToggle.checked && added.from !== me) {
        ctx.play('notify');
        chatOpen.classList.toggle('unread', !root.classList.contains('chatOpen'));
      }
      renderChat();
    },

    fit,

    destroy() {
      release();
      chatOpen.remove();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', fit);
      cancelAnimationFrame(fitFrame);
      container.replaceChildren();
    },
  };
}

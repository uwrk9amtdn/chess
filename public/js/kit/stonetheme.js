// The look of a board of lines with stones on them, shared by the games
// played on one (Go, Gomoku, Mill): the wood, the stones and whether the
// coordinates are shown, chosen in the platform's theme menu and kept for
// next time. The colours are CSS variables on the page's root, so a change
// shows at once on every board, thumbnails included; boards redraw their
// coordinates when they hear THEME_EVENT. The root also names the board and
// stones (data-kit-board, data-kit-stones) for looks that take more than
// colours, such as the glass board.
//
// Every game using it exports the same `settings`, and the platform draws a
// settings function only once, so the menu has one set of these choices.

import { el, load, save } from './dom.js';

const THEME_KEY = 'stones.theme';
// Where Go kept the same choices before they were shared.
const OLD_KEY = 'go.theme';
export const THEME_EVENT = 'kit-stones-theme';

// The board's colour and the colour of its lines.
export const BOARDS = {
  kaya: { name: 'Kaya', wood: '#dcb35c', line: '#3d2b14' },
  light: { name: 'Light', wood: '#ecd2a0', line: '#4a3820' },
  walnut: { name: 'Walnut', wood: '#b88a52', line: '#24180a' },
  green: { name: 'Green', wood: '#a9bf8c', line: '#26331a' },
  blue: { name: 'Blue', wood: '#adbfcc', line: '#1f2c36' },
  grey: { name: 'Grey', wood: '#c9c9c9', line: '#2e2e2e' },
  // Smoked and see-through, for the platform's Glass theme; kit.css frosts it.
  glass: { name: 'Glass', wood: 'rgba(20, 24, 36, 0.28)', line: 'rgba(255, 255, 255, 0.85)' },
};

// How the stones are filled: a gradient from the shared definitions below,
// or a flat colour.
export const STONES = {
  shaded: { name: 'Shaded', black: 'url(#kit-shaded-b)', white: 'url(#kit-shaded-w)' },
  slate: { name: 'Slate', black: 'url(#kit-slate-b)', white: 'url(#kit-slate-w)' },
  flat: { name: 'Flat', black: '#1b1b1b', white: '#f7f7f7' },
  glass: { name: 'Glass', black: 'url(#kit-glass-b)', white: 'url(#kit-glass-w)' },
};

const SVG = 'http://www.w3.org/2000/svg';

// The gradients, once for the whole page. Each stone's fill refers to one.
const defs = document.createElementNS(SVG, 'svg');
defs.setAttribute('aria-hidden', 'true');
defs.style.cssText = 'position: absolute; width: 0; height: 0';
defs.innerHTML = `<defs>
  <radialGradient id="kit-shaded-b" cx="0.35" cy="0.3" r="0.75">
    <stop offset="0" stop-color="#6b6b6b"/><stop offset="0.5" stop-color="#1c1c1c"/><stop offset="1" stop-color="#000"/>
  </radialGradient>
  <radialGradient id="kit-shaded-w" cx="0.35" cy="0.3" r="0.8">
    <stop offset="0" stop-color="#fff"/><stop offset="0.6" stop-color="#e9e9e4"/><stop offset="1" stop-color="#b9b9b2"/>
  </radialGradient>
  <radialGradient id="kit-slate-b" cx="0.45" cy="0.4" r="0.7">
    <stop offset="0" stop-color="#3d3f3e"/><stop offset="1" stop-color="#151716"/>
  </radialGradient>
  <radialGradient id="kit-slate-w" cx="0.45" cy="0.4" r="0.7">
    <stop offset="0" stop-color="#fdfaf2"/><stop offset="1" stop-color="#ddd5c2"/>
  </radialGradient>
  <linearGradient id="kit-glass-b" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#3a3f5c" stop-opacity="0.85"/><stop offset="0.55" stop-color="#10121e" stop-opacity="0.65"/><stop offset="1" stop-color="#05060c" stop-opacity="0.9"/>
  </linearGradient>
  <linearGradient id="kit-glass-w" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="0.55" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#dfe8ff" stop-opacity="0.75"/>
  </linearGradient>
</defs>`;
document.body.append(defs);

let theme = { board: 'kaya', stones: 'shaded', coords: true };
const saved = load(THEME_KEY) || load(OLD_KEY) || {};
if (saved.board in BOARDS) theme.board = saved.board;
if (saved.stones in STONES) theme.stones = saved.stones;
if (typeof saved.coords === 'boolean') theme.coords = saved.coords;

function apply() {
  document.documentElement.dataset.kitBoard = theme.board;
  document.documentElement.dataset.kitStones = theme.stones;
  const root = document.documentElement.style;
  const board = BOARDS[theme.board];
  const stones = STONES[theme.stones];
  root.setProperty('--kit-wood', board.wood);
  root.setProperty('--kit-line', board.line);
  root.setProperty('--kit-black', stones.black);
  root.setProperty('--kit-white', stones.white);
}
apply();

export const showCoordinates = () => theme.coords;

function choose(change) {
  theme = { ...theme, ...change };
  apply();
  document.dispatchEvent(new Event(THEME_EVENT));
  save(THEME_KEY, theme);
}

// A corner of a board with a stone of each colour, for the menu.
function sample(wood, line, black, white) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 3 2');
  svg.classList.add('kitThemeSample');
  svg.innerHTML = `<rect width="3" height="2" fill="${wood}"/>
    <path d="M0 1H3M1 0V2M2 0V2" stroke="${line}" stroke-width="0.06"/>
    <circle class="kitStone b" cx="1" cy="1" r="0.46" fill="${black}"/>
    <circle class="kitStone w" cx="2" cy="1" r="0.46" fill="${white}"/>`;
  return svg;
}

// The bottom left corner of the board, with or without its coordinates.
function coordsSample(wood, line, on) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 3 2');
  svg.classList.add('kitThemeSample');
  const labels = on ? `<g fill="${line}" font-size="0.42" font-weight="600" text-anchor="middle" dominant-baseline="central">
    <text x="0.35" y="0.8">2</text><text x="0.35" y="1.4">1</text><text x="1" y="1.8">A</text><text x="1.6" y="1.8">B</text><text x="2.2" y="1.8">C</text>
  </g>` : '';
  svg.innerHTML = `<rect width="3" height="2" fill="${wood}"/>
    <path d="M1 0.2V1.4H3M1 0.8H3M1.6 0.2V1.4M2.2 0.2V1.4" fill="none" stroke="${line}" stroke-width="0.06"/>${labels}`;
  return svg;
}

// The board and stone choices, for the platform's theme menu. Each option is
// drawn as it would look, so the menu is its own preview.
export function settings(container) {
  const boards = el('div', { className: 'kitThemeOptions' });
  const stones = el('div', { className: 'kitThemeOptions' });
  const coords = el('div', { className: 'kitThemeOptions' });
  function render() {
    const now = STONES[theme.stones];
    boards.replaceChildren(...Object.entries(BOARDS).map(([id, board]) => option(
      board.name, sample(board.wood, board.line, now.black, now.white), theme.board === id, () => choose({ board: id }),
    )));
    const wood = BOARDS[theme.board];
    stones.replaceChildren(...Object.entries(STONES).map(([id, set]) => option(
      set.name, sample(wood.wood, wood.line, set.black, set.white), theme.stones === id, () => choose({ stones: id }),
    )));
    coords.replaceChildren(...[[true, 'On'], [false, 'Off']].map(([on, name]) => option(
      name, coordsSample(wood.wood, wood.line, on), theme.coords === on, () => choose({ coords: on }),
    )));
  }
  function option(name, picture, selected, pick) {
    return el('button', {
      type: 'button',
      className: selected ? 'selected' : '',
      title: name,
      ariaPressed: String(selected),
      onclick: () => {
        pick();
        render();
      },
    }, picture, el('span', { textContent: name }));
  }
  render();
  container.append(el('h3', { textContent: 'Go, Gomoku & Mill board' }), boards, el('h3', { textContent: 'Go, Gomoku & Mill stones' }), stones,
    el('h3', { textContent: 'Go, Gomoku & Mill coordinates' }), coords);
}

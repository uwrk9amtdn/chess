// The look of the board: its colours and the piece set, chosen in the
// platform's theme menu and kept for next time. Both are CSS variables on the
// page's root, so a change shows at once on every board, thumbnails included.
// The root also names both choices (data-chess-board, data-chess-pieces) for
// looks that take more than colours, such as the glass board.

const THEME_KEY = 'chess.theme';

// Light and dark squares.
export const BOARDS = {
  brown: { name: 'Brown', light: '#f0d9b5', dark: '#b58863' },
  blue: { name: 'Blue', light: '#dee3e6', dark: '#8ca2ad' },
  green: { name: 'Green', light: '#ffffdd', dark: '#86a666' },
  purple: { name: 'Purple', light: '#9f90b0', dark: '#7d4a8d' },
  grey: { name: 'Grey', light: '#dcdcdc', dark: '#a8a8a8' },
  pink: { name: 'Pink', light: '#f1f1c9', dark: '#f07272' },
  // See-through, for the platform's Glass theme; chess.css frosts it.
  glass: { name: 'Glass', light: 'rgba(255, 255, 255, 0.4)', dark: 'rgba(255, 255, 255, 0.1)' },
};

// One folder of pieces/ each; see pieces/LICENSE.md.
export const PIECE_SETS = {
  cburnett: 'Cburnett',
  merida: 'Merida',
  chessnut: 'Chessnut',
  fantasy: 'Fantasy',
  celtic: 'Celtic',
  spatial: 'Spatial',
  pixel: 'Pixel',
  rhosgfx: 'Rhosgfx',
  glass: 'Glass',
};

const TYPES = ['K', 'Q', 'R', 'B', 'N', 'P'];
// Even seats play white.
const COLOURS = ['w', 'b'];

const fileUrl = (set, name) => new URL(`./pieces/${set}/${name}.svg`, import.meta.url).href;

// The CSS background of a piece in whichever set is chosen.
export const pieceImage = (type, seat) => `var(--chess-piece-${COLOURS[seat % 2]}${type.toUpperCase()})`;

let theme = { board: 'brown', pieces: 'cburnett' };
try {
  const saved = JSON.parse(localStorage.getItem(THEME_KEY)) || {};
  if (saved.board in BOARDS) theme.board = saved.board;
  if (saved.pieces in PIECE_SETS) theme.pieces = saved.pieces;
} catch {
  // Without storage the board looks as it always did.
}

function apply() {
  document.documentElement.dataset.chessBoard = theme.board;
  document.documentElement.dataset.chessPieces = theme.pieces;
  const root = document.documentElement.style;
  const board = BOARDS[theme.board];
  root.setProperty('--sq-light', board.light);
  root.setProperty('--sq-dark', board.dark);
  for (const colour of COLOURS) {
    for (const type of TYPES) root.setProperty(`--chess-piece-${colour}${type}`, `url("${fileUrl(theme.pieces, colour + type)}")`);
  }
}
apply();

function choose(change) {
  theme = { ...theme, ...change };
  apply();
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(theme));
  } catch {
    // The choice then lasts until the page closes.
  }
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// The board and piece choices, for the platform's theme menu. Each option is
// drawn as it would look, so the menu is its own preview.
export function settings(container) {
  const boards = el('div', { className: 'chessThemeOptions' });
  const pieces = el('div', { className: 'chessThemeOptions' });
  function render() {
    boards.replaceChildren(...Object.entries(BOARDS).map(([id, board]) => {
      const squares = el('span', { className: 'chessThemeSquares' });
      for (const colour of ['light', 'dark', 'dark', 'light']) {
        squares.append(el('span', { style: `background: ${board[colour]}` }));
      }
      return option(board.name, squares, theme.board === id, () => choose({ board: id }));
    }));
    pieces.replaceChildren(...Object.entries(PIECE_SETS).map(([id, name]) => {
      // The knight on both colours of the chosen board.
      const sample = el('span', { className: 'chessThemePieces' });
      for (const colour of COLOURS) {
        sample.append(el('span', { style: `background-image: url("${fileUrl(id, `${colour}N`)}")` }));
      }
      return option(name, sample, theme.pieces === id, () => choose({ pieces: id }));
    }));
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
  container.append(el('h3', { textContent: 'Board' }), boards, el('h3', { textContent: 'Pieces' }), pieces);
}

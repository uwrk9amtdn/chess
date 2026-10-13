// Variant definitions. The engine reads everything about the board and the
// players from here, so a new game mode is a new entry in `variants`.
//
// Coordinates: x is the file (0 = a), y is the rank (0 = rank 1).
// A seat is one player's army. Seats on the same team never capture each
// other, and `clock` says which clock runs on that seat's turn (team mates can
// share one by using the same index).

import { chess960Rank, POSITIONS, STANDARD_POSITION } from './chess960.js';

// Two armies facing each other across the board: seat 0 at the bottom, seat 1
// at the top, each with a back rank and a row of pawns in front of it.
export function facingSetup(backRank, height) {
  const setup = [];
  backRank.forEach((type, x) => {
    setup.push({ type, seat: 0, x, y: 0 });
    setup.push({ type: 'p', seat: 0, x, y: 1 });
    setup.push({ type, seat: 1, x, y: height - 1 });
    setup.push({ type: 'p', seat: 1, x, y: height - 2 });
  });
  return setup;
}

const STANDARD_RANK = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];

// What the engine reads from a variant besides the board and the seats. A
// flag that is left out means "as in standard chess".
//
//   setupFor(n)    several starting positions; `defaultStart` is the usual one
//   castling       'fischer': king and rook end where they do in standard
//                  chess wherever they start; 'none': no castling
//   royal          false: kings are ordinary pieces, there is no check
//   forcedCapture  a capture must be made when one is possible
//   explosions     a capture removes the capturer and all it touches but pawns
//   noChecks       a move that gives check is illegal
//   hill           squares a king wins by reaching
//   goalRank       rank (y) a king wins by reaching
//   checkLimit     giving this many checks wins
//   horde          team that has no king and loses when all its pieces are gone
//   doubleStepFromBackRank  pawns may also move two squares from the back rank
//   drops          captured pieces go to a pocket and can be put back
//   material       'none' or 'bareKings': how far the insufficient-material draw applies
//   flagAlwaysLoses  running out of time loses whatever the opponent has left
//   fixedView      both players see the board from the first seat's side
//
// `icon` and `description` are for the list a player chooses from. The icon
// is a character of the Lichess icon font (client/font), or with `plainIcon`
// of the ordinary text font.

export const standard = {
  id: 'standard',
  name: 'Standard',
  icon: '\ue016',
  description: 'Standard rules of chess (FIDE)',
  width: 8,
  height: 8,
  seats: [
    { id: 'white', team: 0, forward: [0, 1], clock: 0 },
    { id: 'black', team: 1, forward: [0, -1], clock: 1 },
  ],
  turnOrder: [0, 1],
  promotionTypes: ['q', 'r', 'b', 'n'],
  setup: facingSetup(STANDARD_RANK, 8),
};

export const chess960 = {
  ...standard,
  id: 'chess960',
  name: 'Chess960',
  icon: '\ue006',
  description: 'The starting position of the home rank pieces is randomized.',
  castling: 'fischer',
  starts: POSITIONS,
  defaultStart: STANDARD_POSITION,
  setupFor: (n) => facingSetup(chess960Rank(n), 8),
};

export const kingOfTheHill = {
  ...standard,
  id: 'kingOfTheHill',
  name: 'King of the Hill',
  icon: '\ue007',
  description: 'Bring your King to the center to win the game.',
  hill: [27, 28, 35, 36],
  material: 'none',
};

export const threeCheck = {
  ...standard,
  id: 'threeCheck',
  name: 'Three-Check',
  icon: '\ue00d',
  description: 'Check your opponent 3 times to win the game.',
  checkLimit: 3,
  material: 'bareKings',
};

export const antichess = {
  ...standard,
  id: 'antichess',
  name: 'Antichess',
  icon: '\ue01e',
  description: 'Lose all your pieces (or get stalemated) to win the game.',
  royal: false,
  forcedCapture: true,
  promotionTypes: ['q', 'r', 'b', 'n', 'k'],
  material: 'none',
  flagAlwaysLoses: true,
};

export const atomic = {
  ...standard,
  id: 'atomic',
  name: 'Atomic',
  icon: '\ue01c',
  description: "Nuke your opponent's king to win.",
  explosions: true,
  material: 'bareKings',
  flagAlwaysLoses: true,
};

// White is the horde: pawns on its first four ranks and four more in front.
const HORDE_PAWNS = [];
for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) HORDE_PAWNS.push({ type: 'p', seat: 0, x, y });
for (const x of [1, 2, 5, 6]) HORDE_PAWNS.push({ type: 'p', seat: 0, x, y: 4 });

export const horde = {
  ...standard,
  id: 'horde',
  name: 'Horde',
  icon: '\ue03d',
  description: 'One side has a large number of pawns, the other has a normal army.',
  horde: 0,
  doubleStepFromBackRank: true,
  material: 'none',
  flagAlwaysLoses: true,
  setup: [...HORDE_PAWNS, ...facingSetup(STANDARD_RANK, 8).filter((p) => p.seat === 1)],
};

// Both armies start side by side on the first two ranks and race up the board.
const RACING_RANKS = [['q', 'r', 'b', 'n', 'n', 'b', 'r', 'q'], ['k', 'r', 'b', 'n', 'n', 'b', 'r', 'k']];

export const racingKings = {
  ...standard,
  id: 'racingKings',
  name: 'Racing Kings',
  icon: '\ue065',
  description: 'Get your king to the other side of the board to win.',
  noChecks: true,
  castling: 'none',
  goalRank: 7,
  material: 'none',
  flagAlwaysLoses: true,
  fixedView: true,
  // Black has the queenside half, White the kingside half.
  setup: RACING_RANKS.flatMap((rank, y) => rank.map((type, x) => ({ type, seat: x < 4 ? 1 : 0, x, y }))),
};

export const crazyhouse = {
  ...standard,
  id: 'crazyhouse',
  name: 'Crazyhouse',
  icon: '\ue066',
  description: 'Captured pieces can be dropped back on the board instead of moving a piece.',
  drops: true,
  material: 'none',
  flagAlwaysLoses: true,
};

// Two standard armies side by side for each player on a 16x16 board, so each
// side has two kings and two queens. The engine treats every king as royal:
// a move may not leave either of them attacked, and a player whose king is
// checkmated loses even if the other king is safe.
export const double = {
  ...standard,
  id: 'double',
  name: 'Double 16x16',
  icon: '⊞',
  plainIcon: true,
  description: 'Two armies each on a 16x16 board: two kings to guard, two queens to attack with.',
  width: 16,
  height: 16,
  setup: facingSetup([...STANDARD_RANK, ...STANDARD_RANK], 16),
};

export const variants = {
  standard, chess960, kingOfTheHill, threeCheck, antichess, atomic, horde, racingKings, crazyhouse, double,
};

// Bots come in levels 1 (weakest) to BOT_LEVELS. Stockfish plays the variants
// it knows the rules of; the search in search.js plays the others.
export const BOT_LEVELS = 8;
export const STOCKFISH_VARIANTS = ['standard', 'chess960'];

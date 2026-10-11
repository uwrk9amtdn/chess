// Variant definitions. The engine reads everything about the board and the
// players from here, so a new game mode is a new entry in `variants`.
//
// Coordinates: x is the file (0 = a), y is the rank (0 = rank 1).
// A seat is one player's army. Seats on the same team never capture each
// other, and `clock` says which clock runs on that seat's turn (team mates can
// share one by using the same index).

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

export const standard = {
  id: 'standard',
  name: 'Standard',
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

// Two standard armies side by side for each player on a 16x16 board, so each
// side has two kings and two queens. The engine treats every king as royal:
// a move may not leave either of them attacked, and a player whose king is
// checkmated loses even if the other king is safe.
export const double = {
  ...standard,
  id: 'double',
  name: 'Double 16x16',
  width: 16,
  height: 16,
  setup: facingSetup([...STANDARD_RANK, ...STANDARD_RANK], 16),
};

export const variants = { standard, double };

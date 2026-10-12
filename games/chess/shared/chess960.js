// The 960 starting positions of Chess960, numbered the usual way (Scharnagl):
// 518 is the standard chess position.

// Where the king, rooks and knights go on the five files left once the
// bishops and the queen are placed. The king is always between the rooks.
const KING_ROOKS_KNIGHTS = ['nnrkr', 'nrnkr', 'nrknr', 'nrkrn', 'rnnkr', 'rnknr', 'rnkrn', 'rknnr', 'rknrn', 'rkrnn'];

export const POSITIONS = 960;
export const STANDARD_POSITION = 518;

// The back rank of position `n` (0 to 959), from the a-file to the h-file.
export function chess960Rank(n) {
  const rank = new Array(8).fill(null);
  const free = () => rank.flatMap((type, file) => (type ? [] : [file]));
  rank[(n % 4) * 2 + 1] = 'b';
  n = Math.floor(n / 4);
  rank[(n % 4) * 2] = 'b';
  n = Math.floor(n / 4);
  rank[free()[n % 6]] = 'q';
  n = Math.floor(n / 6);
  free().forEach((file, i) => {
    rank[file] = KING_ROOKS_KNIGHTS[n][i];
  });
  return rank;
}

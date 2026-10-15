// Rules engine shared by the server (the authority) and the browser (move
// hints). Nothing here assumes an 8x8 board or two players: geometry, seats,
// teams and turn order all come from the variant definition, and so do the
// rules that differ from standard chess (see the flags in variants.js).
//
// A state is { variant, board, turn, ep, halfmove, history } and is never
// mutated; applyMove returns a new one. `board` is a flat array of
// { type, seat, moved } or null, indexed y * width + x. Some variants add to
// the state: `checks` (checks given, per team) and `pockets` (captured pieces
// a seat may drop back, as { type: count }).
//
// A move is { from, to } plus what it does (capture, promotion, castle, ...);
// a drop from the pocket is { drop: type, to }.

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
const ALL = [...ORTHO, ...DIAG];
const SLIDES = { b: DIAG, r: ORTHO, q: ALL };

export function seatToMove(state) {
  return state.variant.turnOrder[state.turn];
}

export function teamOf(variant, seat) {
  return variant.seats[seat].team;
}

// The team that wins when `team` loses. Only meaningful with two teams.
export function opposingTeam(variant, team) {
  const other = variant.seats.find((s) => s.team !== team);
  return other ? other.team : null;
}

function positionKey(state) {
  let key = '';
  for (const p of state.board) {
    if (!p) key += '-';
    else key += p.type + p.seat + (!p.moved && (p.type === 'k' || p.type === 'r') ? '*' : '');
  }
  key += `|${state.turn}|${state.ep ? state.ep.square : ''}`;
  if (state.checks) key += `|${state.checks}`;
  if (state.pockets) key += `|${state.pockets.map((pocket) => POCKET_TYPES.map((t) => pocket[t] || 0).join('')).join('/')}`;
  return key;
}

// The pieces a pocket can hold, in the order they are shown.
export const POCKET_TYPES = ['p', 'n', 'b', 'r', 'q'];

// A position with nothing played yet: the parts of a state that only some
// variants have are added here.
function newState(variant, board, turn, ep, halfmove) {
  const state = { variant, board, turn, ep, halfmove, history: [] };
  if (variant.checkLimit) state.checks = teamsOf(variant).map(() => 0);
  if (variant.drops) state.pockets = variant.seats.map(() => ({}));
  state.history = [positionKey(state)];
  return state;
}

const teamsOf = (variant) => [...new Set(variant.seats.map((s) => s.team))];

// `start` picks the starting position in variants that have several, such as
// Chess960; it is ignored by the others.
export function createGame(variant, start) {
  const board = new Array(variant.width * variant.height).fill(null);
  const setup = variant.setupFor ? variant.setupFor(start ?? variant.defaultStart) : variant.setup;
  for (const p of setup) {
    board[p.y * variant.width + p.x] = { type: p.type, seat: p.seat, moved: false };
  }
  return newState(variant, board, 0, null, 0);
}

// Is the square attacked by any piece that is not on `team`? Where captures
// explode, a king never captures and so attacks nothing.
function isAttacked(state, idx, team) {
  const { variant, board } = state;
  const kingsAttack = !variant.explosions;
  const w = variant.width;
  const h = variant.height;
  const x = idx % w;
  const y = (idx - x) / w;
  const enemyAt = (px, py) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return null;
    const p = board[py * w + px];
    return p && variant.seats[p.seat].team !== team ? p : null;
  };

  for (const [dx, dy] of KNIGHT) {
    const p = enemyAt(x + dx, y + dy);
    if (p && p.type === 'n') return true;
  }

  for (const [dx, dy] of ALL) {
    const slider = dx !== 0 && dy !== 0 ? 'b' : 'r';
    let cx = x + dx;
    let cy = y + dy;
    let dist = 1;
    while (cx >= 0 && cy >= 0 && cx < w && cy < h) {
      const p = board[cy * w + cx];
      if (p) {
        if (variant.seats[p.seat].team !== team &&
            (p.type === 'q' || p.type === slider || (dist === 1 && p.type === 'k' && kingsAttack))) {
          return true;
        }
        break;
      }
      cx += dx;
      cy += dy;
      dist++;
    }
  }

  for (let s = 0; s < variant.seats.length; s++) {
    if (variant.seats[s].team === team) continue;
    const [fx, fy] = variant.seats[s].forward;
    for (const side of [1, -1]) {
      const p = enemyAt(x - (fx + side * fy), y - (fy + side * fx));
      if (p && p.type === 'p' && p.seat === s) return true;
    }
  }
  return false;
}

export function kingSquares(state, team) {
  const squares = [];
  const { variant, board } = state;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (p && p.type === 'k' && variant.seats[p.seat].team === team) squares.push(i);
  }
  return squares;
}

// Is there a king of another team next to the square?
function nearEnemyKing(state, idx, team) {
  const { variant, board } = state;
  const w = variant.width;
  const x = idx % w;
  const y = (idx - x) / w;
  return ALL.some(([dx, dy]) => {
    if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= variant.height) return false;
    const p = board[(y + dy) * w + x + dx];
    return p && p.type === 'k' && variant.seats[p.seat].team !== team;
  });
}

// May a king of `team` stand on the square? With explosions, kings that touch
// cannot be attacked: taking one would blow up the other.
function isSafe(state, idx, team) {
  if (state.variant.explosions && nearEnemyKing(state, idx, team)) return true;
  return !isAttacked(state, idx, team);
}

export function inCheck(state, team) {
  if (state.variant.royal === false) return false;
  return kingSquares(state, team).some((i) => !isSafe(state, i, team));
}

// How far the square is from the edge the seat's pawns start from.
function rankOf(variant, seat, x, y) {
  const [fx, fy] = variant.seats[seat].forward;
  if (fy > 0) return y;
  if (fy < 0) return variant.height - 1 - y;
  return fx > 0 ? x : variant.width - 1 - x;
}

// Moves that obey how the pieces move, ignoring whether they leave a king
// attacked. `only` restricts generation to the piece on that square.
function pseudoMoves(state, seat, only) {
  const { variant, board, ep } = state;
  const w = variant.width;
  const h = variant.height;
  const team = variant.seats[seat].team;
  const [fx, fy] = variant.seats[seat].forward;
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h;
  const isEnemy = (p) => variant.seats[p.seat].team !== team;
  const moves = [];
  const start = only === undefined ? 0 : only;
  const end = only === undefined ? board.length : only + 1;

  for (let from = start; from < end; from++) {
    const p = board[from];
    if (!p || p.seat !== seat) continue;
    const x = from % w;
    const y = (from - x) / w;

    if (p.type === 'p') {
      // A pawn promotes when it has no square left in front of it.
      const addPawnMove = (to, tx, ty, extra) => {
        if (inside(tx + fx, ty + fy)) moves.push({ from, to, ...extra });
        else for (const promotion of variant.promotionTypes) moves.push({ from, to, promotion, ...extra });
      };
      if (inside(x + fx, y + fy) && !board[(y + fy) * w + x + fx]) {
        const one = (y + fy) * w + x + fx;
        addPawnMove(one, x + fx, y + fy);
        const x2 = x + 2 * fx;
        const y2 = y + 2 * fy;
        // Two squares from the rank the pawns start on (in Horde also from
        // the one behind it, where a double step cannot be taken en passant).
        const rank = rankOf(variant, seat, x, y);
        if ((rank === 1 || (rank === 0 && variant.doubleStepFromBackRank)) && inside(x2, y2) && !board[y2 * w + x2]) {
          moves.push(rank === 1 ? { from, to: y2 * w + x2, double: one } : { from, to: y2 * w + x2 });
        }
      }
      for (const side of [1, -1]) {
        const tx = x + fx + side * fy;
        const ty = y + fy + side * fx;
        if (!inside(tx, ty)) continue;
        const to = ty * w + tx;
        const target = board[to];
        if (target) {
          if (isEnemy(target)) addPawnMove(to, tx, ty, { capture: to });
        } else if (ep && ep.square === to && variant.seats[ep.seat].team !== team) {
          moves.push({ from, to, capture: ep.pawn, enPassant: true });
        }
      }
      continue;
    }

    if (p.type === 'n' || p.type === 'k') {
      for (const [dx, dy] of p.type === 'n' ? KNIGHT : ALL) {
        if (!inside(x + dx, y + dy)) continue;
        const to = (y + dy) * w + x + dx;
        const target = board[to];
        if (!target) moves.push({ from, to });
        // Where captures explode, a king cannot capture: it would die too.
        else if (isEnemy(target) && !(p.type === 'k' && variant.explosions)) moves.push({ from, to, capture: to });
      }
    } else {
      for (const [dx, dy] of SLIDES[p.type]) {
        let cx = x + dx;
        let cy = y + dy;
        while (inside(cx, cy)) {
          const to = cy * w + cx;
          const target = board[to];
          if (!target) moves.push({ from, to });
          else {
            if (isEnemy(target)) moves.push({ from, to, capture: to });
            break;
          }
          cx += dx;
          cy += dy;
        }
      }
    }

    if (p.type === 'k' && !p.moved && variant.royal !== false && variant.castling !== 'none') {
      if (variant.castling === 'fischer') fischerCastling(state, from, moves);
      else classicCastling(state, from, moves);
    }
  }
  return moves;
}

// Castling: an unmoved king steps two squares towards an unmoved rook of its
// own army along the back rank, with nothing in between, and the rook lands
// on the square the king crossed. The king may not start on, cross or land on
// an attacked square.
function classicCastling(state, from, moves) {
  const { variant, board } = state;
  const w = variant.width;
  const { seat } = board[from];
  const team = variant.seats[seat].team;
  const fy = variant.seats[seat].forward[1];
  const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < variant.height;
  const x = from % w;
  const y = (from - x) / w;
  if (!isSafe(state, from, team)) return;
  const ax = fy !== 0 ? 1 : 0;
  const ay = fy !== 0 ? 0 : 1;
  for (const side of [1, -1]) {
    const dx = ax * side;
    const dy = ay * side;
    let cx = x + dx;
    let cy = y + dy;
    let dist = 1;
    while (inside(cx, cy) && !board[cy * w + cx]) {
      cx += dx;
      cy += dy;
      dist++;
    }
    if (!inside(cx, cy) || dist < 3) continue;
    const rookFrom = cy * w + cx;
    const rook = board[rookFrom];
    if (rook.type !== 'r' || rook.seat !== seat || rook.moved) continue;
    const rookTo = (y + dy) * w + x + dx;
    const to = (y + 2 * dy) * w + x + 2 * dx;
    if (!isSafe(state, rookTo, team) || !isSafe(state, to, team)) continue;
    moves.push({ from, to, castle: { rookFrom, rookTo } });
  }
}

// Castling when king and rooks may start on any file: whichever rook it is,
// the king ends on the c- or g-file and the rook next to it on the d- or
// f-file, as in standard chess. Every square either piece passes over or
// lands on must be empty apart from the two of them, and the king may not
// start on, cross or land on an attacked square. The move is written as the
// king going to the rook's square, which no other move can be.
function fischerCastling(state, from, moves) {
  const { variant, board } = state;
  const w = variant.width;
  const { seat } = board[from];
  const team = variant.seats[seat].team;
  const x = from % w;
  const row = from - x;
  for (let rx = 0; rx < w; rx++) {
    const rook = board[row + rx];
    if (!rook || rook.type !== 'r' || rook.seat !== seat || rook.moved) continue;
    const kingX = rx > x ? w - 2 : 2;
    const rookX = rx > x ? w - 3 : 3;
    const lo = Math.min(x, rx, kingX, rookX);
    const hi = Math.max(x, rx, kingX, rookX);
    let clear = true;
    for (let cx = lo; cx <= hi; cx++) if (cx !== x && cx !== rx && board[row + cx]) clear = false;
    if (!clear) continue;
    // Attacks are judged with the king and the rook lifted off the board:
    // neither shields a square the king crosses.
    const lifted = board.slice();
    lifted[from] = null;
    lifted[row + rx] = null;
    const bare = { ...state, board: lifted };
    let safe = true;
    for (let cx = Math.min(x, kingX); cx <= Math.max(x, kingX); cx++) if (!isSafe(bare, row + cx, team)) safe = false;
    if (!safe) continue;
    moves.push({ from, to: row + rx, castle: { rookFrom: row + rx, rookTo: row + rookX, kingTo: row + kingX } });
  }
}

// Every way to put a piece from the pocket back on the board. A pawn may not
// go on the rank it would promote on, nor on the one behind its start.
function dropMoves(state, seat, only) {
  const { variant, board } = state;
  const pocket = state.pockets ? state.pockets[seat] : {};
  const [fx, fy] = variant.seats[seat].forward;
  const w = variant.width;
  const moves = [];
  for (const type of POCKET_TYPES) {
    if (!pocket[type] || (only !== undefined && only !== type)) continue;
    for (let to = 0; to < board.length; to++) {
      if (board[to]) continue;
      if (type === 'p') {
        const x = to % w;
        const y = (to - x) / w;
        const ahead = x + fx >= 0 && x + fx < w && y + fy >= 0 && y + fy < variant.height;
        if (!ahead || rankOf(variant, seat, x, y) === 0) continue;
      }
      moves.push({ drop: type, to });
    }
  }
  return moves;
}

// Plays a move without checking legality or recording history.
function play(state, move) {
  const { variant } = state;
  const w = variant.width;
  const board = state.board.slice();
  const seat = seatToMove(state);
  const next = {
    variant,
    board,
    turn: (state.turn + 1) % variant.turnOrder.length,
    ep: null,
    halfmove: state.halfmove + 1,
    history: state.history,
  };
  if (state.pockets) next.pockets = state.pockets;
  const pocketChange = (type, by) => {
    next.pockets = next.pockets.slice();
    next.pockets[seat] = { ...next.pockets[seat], [type]: (next.pockets[seat][type] || 0) + by };
  };

  if (move.drop) {
    board[move.to] = { type: move.drop, seat, moved: true };
    pocketChange(move.drop, -1);
    if (move.drop === 'p') next.halfmove = 0;
  } else {
    const p = board[move.from];
    const captured = move.capture === undefined ? null : board[move.capture];
    if (captured) board[move.capture] = null;
    board[move.from] = null;
    if (move.castle) {
      const rook = board[move.castle.rookFrom];
      board[move.castle.rookFrom] = null;
      board[move.castle.kingTo ?? move.to] = { type: p.type, seat, moved: true };
      board[move.castle.rookTo] = { type: rook.type, seat, moved: true };
    } else {
      board[move.to] = { type: move.promotion || p.type, seat, moved: true };
      // A promoted piece that is captured goes back to being a pawn.
      if (p.promoted || move.promotion) board[move.to].promoted = true;
    }
    if (move.double !== undefined) next.ep = { square: move.double, pawn: move.to, seat };
    if (p.type === 'p' || captured) next.halfmove = 0;
    if (captured && state.pockets && captured.type !== 'k') pocketChange(captured.promoted ? 'p' : captured.type, 1);
    // A capture blows up the capturing piece and everything around the square
    // it lands on, except pawns.
    if (captured && variant.explosions) {
      const x = move.to % w;
      const y = (move.to - x) / w;
      board[move.to] = null;
      for (const [dx, dy] of ALL) {
        if (x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= variant.height) continue;
        const near = (y + dy) * w + x + dx;
        if (board[near] && board[near].type !== 'p') board[near] = null;
      }
    }
  }

  if (state.checks) {
    next.checks = state.checks;
    const team = variant.seats[seat].team;
    if (inCheck(next, opposingTeam(variant, team))) {
      next.checks = state.checks.slice();
      next.checks[team]++;
    }
  }
  return next;
}

function kingCount(state, team, own) {
  let count = 0;
  for (const p of state.board) if (p && p.type === 'k' && (state.variant.seats[p.seat].team === team) === own) count++;
  return count;
}

// A move is legal when it leaves no king of the mover's team attacked, with
// the exceptions some variants make.
function isLegal(state, move, team) {
  const { variant } = state;
  if (variant.royal === false) return true;
  const next = play(state, move);
  if (variant.explosions) {
    if (kingCount(next, team, true) < kingCount(state, team, true)) return false;
    // Blowing up the other king wins at once, whatever else is attacked.
    if (kingCount(next, team, false) < kingCount(state, team, false)) return true;
  }
  if (inCheck(next, team)) return false;
  return !(variant.noChecks && inCheck(next, opposingTeam(variant, team)));
}

function generate(state, from, drop) {
  const { variant } = state;
  const seat = seatToMove(state);
  const team = teamOf(variant, seat);
  let moves = drop === undefined ? pseudoMoves(state, seat, from) : [];
  if (state.pockets && from === undefined) moves = moves.concat(dropMoves(state, seat, drop));
  moves = moves.filter((m) => isLegal(state, m, team));
  if (variant.forcedCapture) {
    // A capture must be made if there is one, with any piece.
    const all = from === undefined ? moves : pseudoMoves(state, seat);
    if (all.some((m) => m.capture !== undefined)) moves = moves.filter((m) => m.capture !== undefined);
  }
  return moves;
}

// The ways a variant ends a game other than by having no move left:
// { reason, winner }, or null while play goes on.
function variantEnd(state) {
  const { variant, board } = state;
  const teams = teamsOf(variant);
  const mover = teamOf(variant, seatToMove(state));

  if (variant.explosions) {
    const lost = teams.find((t) => kingCount(state, t, true) === 0);
    if (lost !== undefined) return { reason: 'explosion', winner: opposingTeam(variant, lost) };
  }
  if (variant.hill) {
    const p = variant.hill.map((i) => board[i]).find((q) => q && q.type === 'k');
    if (p) return { reason: 'hill', winner: teamOf(variant, p.seat) };
  }
  if (state.checks) {
    const winner = teams.find((t) => state.checks[t] >= variant.checkLimit);
    if (winner !== undefined) return { reason: 'checks', winner };
  }
  if (variant.horde !== undefined && mover === variant.horde &&
      !board.some((p) => p && teamOf(variant, p.seat) === mover)) {
    return { reason: 'horde', winner: opposingTeam(variant, mover) };
  }
  if (variant.goalRank !== undefined) {
    const w = variant.width;
    const home = (t) => board.some((p, i) => p && p.type === 'k' && teamOf(variant, p.seat) === t &&
      Math.floor(i / w) === variant.goalRank);
    const arrived = teams.filter(home);
    if (arrived.length > 1) return { reason: 'goal', winner: null };
    if (arrived.length === 1) {
      // The side that moved second gets one move to draw level.
      const first = teamOf(variant, variant.turnOrder[0]);
      const canFollow = arrived[0] === first && mover !== first && generate(state).some((m) => {
        const p = board[m.from];
        return p.type === 'k' && Math.floor(m.to / w) === variant.goalRank;
      });
      if (!canFollow) return { reason: 'goal', winner: arrived[0] };
    }
  }
  return null;
}

// Legal moves for the seat to move, optionally only for the piece on `from`.
// Without `from`, drops from the pocket are included. Once a variant's own
// ending has been reached there is nothing left to play.
export function legalMoves(state, from) {
  return variantEnd(state) ? [] : generate(state, from);
}

// The squares a piece of that type may be dropped on from the pocket.
export function legalDrops(state, type) {
  return variantEnd(state) ? [] : generate(state, undefined, type);
}

// Squares the piece on `from` could move to by its geometry alone, whoever is
// to move and whatever stands in the way. These are the moves a player may
// queue while waiting for their turn; findMove decides later if one is legal.
export function premoveTargets(state, from) {
  const { variant, board } = state;
  const p = board[from];
  if (!p) return [];
  const w = variant.width;
  const h = variant.height;
  const x = from % w;
  const y = (from - x) / w;
  const [fx, fy] = variant.seats[p.seat].forward;
  const targets = [];
  const add = (tx, ty) => {
    const inside = tx >= 0 && ty >= 0 && tx < w && ty < h;
    if (inside) targets.push(ty * w + tx);
    return inside;
  };

  if (p.type === 'p') {
    add(x + fx, y + fy);
    if (!p.moved) add(x + 2 * fx, y + 2 * fy);
    for (const side of [1, -1]) add(x + fx + side * fy, y + fy + side * fx);
  } else if (p.type === 'n' || p.type === 'k') {
    for (const [dx, dy] of p.type === 'n' ? KNIGHT : ALL) add(x + dx, y + dy);
    if (p.type === 'k' && !p.moved && variant.castling === 'fischer') {
      // Castling is the king going to one of its own rooks.
      for (let rx = 0; rx < w; rx++) {
        const rook = board[y * w + rx];
        if (rook && rook.type === 'r' && rook.seat === p.seat && !rook.moved) targets.push(y * w + rx);
      }
    } else if (p.type === 'k' && !p.moved) {
      // Castling runs along the back rank, at right angles to the pawns.
      for (const side of [2, -2]) add(x + (fy !== 0 ? side : 0), y + (fy !== 0 ? 0 : side));
    }
  } else {
    for (const [dx, dy] of SLIDES[p.type]) {
      for (let d = 1; add(x + d * dx, y + d * dy); d++);
    }
  }
  return targets;
}

// The position as a player waiting for their turn pictures it once a queued
// move is made: the piece goes where it was sent and takes whatever stands
// there. A king sent two squares, or onto a rook of its own in Chess960,
// castles; a pawn with no square left in front of it becomes the first piece
// on offer. Nothing else changes, not even whose turn it is. This is only for
// drawing; findMove decides later whether the move can be played.
export function playPremove(state, { from, to }) {
  const { variant } = state;
  const w = variant.width;
  const h = variant.height;
  const board = state.board.slice();
  const p = board[from];
  const target = board[to];
  const x = from % w;
  const y = (from - x) / w;
  const tx = to % w;
  const ty = (to - tx) / w;
  const inside = (cx, cy) => cx >= 0 && cy >= 0 && cx < w && cy < h;
  board[from] = null;

  if (p.type === 'k' && variant.castling === 'fischer' && target?.type === 'r' && target.seat === p.seat) {
    const row = from - x;
    board[to] = null;
    board[row + (tx > x ? w - 2 : 2)] = { ...p, moved: true };
    board[row + (tx > x ? w - 3 : 3)] = { ...target, moved: true };
    return { ...state, board };
  }
  if (p.type === 'k' && !p.moved && Math.abs(tx - x) + Math.abs(ty - y) === 2 && (tx === x || ty === y)) {
    // The rook is the first piece beyond the king's square.
    const dx = Math.sign(tx - x);
    const dy = Math.sign(ty - y);
    let cx = tx + dx;
    let cy = ty + dy;
    while (inside(cx, cy) && !board[cy * w + cx]) {
      cx += dx;
      cy += dy;
    }
    const rook = inside(cx, cy) ? board[cy * w + cx] : null;
    if (rook && rook.type === 'r' && rook.seat === p.seat && !rook.moved) {
      board[cy * w + cx] = null;
      board[(y + dy) * w + x + dx] = { ...rook, moved: true };
    }
  }
  const [fx, fy] = variant.seats[p.seat].forward;
  const promotes = p.type === 'p' && !inside(tx + fx, ty + fy);
  board[to] = { ...p, type: promotes ? variant.promotionTypes[0] : p.type, moved: true };
  return { ...state, board };
}

// Resolves { from, to, promotion } or { drop, to } to the full legal move, or
// null.
export function findMove(state, { from, to, promotion, drop } = {}) {
  if (drop !== undefined) {
    if (!POCKET_TYPES.includes(drop)) return null;
    return legalDrops(state, drop).find((m) => m.to === to) || null;
  }
  if (!Number.isInteger(from) || from < 0 || from >= state.board.length) return null;
  return legalMoves(state, from).find((m) => m.to === to && m.promotion === (promotion || undefined)) || null;
}

// Returns the state after the move, or null if the move is not legal.
export function applyMove(state, move) {
  const legal = findMove(state, move);
  return legal ? applyLegal(state, legal) : null;
}

// The same for a move that legalMoves or findMove returned, without looking
// it up again.
export function applyLegal(state, move) {
  const next = play(state, move);
  next.history = [...state.history, positionKey(next)];
  return next;
}

// Can neither side ever win? Variants say how much this rule applies:
// `material` is 'none', 'bareKings' or (by default) the standard rule.
function insufficientMaterial(state) {
  const { variant, board } = state;
  if (variant.material === 'none') return false;
  if (variant.material === 'bareKings') return board.every((p) => !p || p.type === 'k');
  let minors = 0;
  let bishopColours = 0;
  for (let i = 0; i < board.length; i++) {
    const p = board[i];
    if (!p || p.type === 'k') continue;
    if (p.type !== 'b' && p.type !== 'n') return false;
    minors++;
    if (p.type === 'b') bishopColours |= 1 << (((i % variant.width) + Math.floor(i / variant.width)) % 2);
    else bishopColours = 3;
  }
  // Bare kings, a single minor piece, or only bishops on one square colour.
  return minors <= 1 || bishopColours !== 3;
}

// { over, reason, winner, check }. `winner` is a team, or null for a draw.
export function status(state) {
  const { variant } = state;
  const team = teamOf(variant, seatToMove(state));
  const check = inCheck(state, team);
  const end = (reason, winner) => ({ over: true, reason, winner, check });
  const special = variantEnd(state);
  if (special) return end(special.reason, special.winner);
  if (generate(state).length === 0) {
    // In Antichess running out of moves, or of pieces, is how you win.
    if (variant.royal === false) return end('antichess', team);
    return check ? end('checkmate', opposingTeam(variant, team)) : end('stalemate', null);
  }
  if (insufficientMaterial(state)) return end('material', null);
  const key = state.history[state.history.length - 1];
  if (state.history.filter((k) => k === key).length >= 3) return end('repetition', null);
  if (state.halfmove >= 50 * variant.turnOrder.length) return end('fifty', null);
  return { over: false, reason: null, winner: null, check };
}

export function squareName(variant, idx) {
  const x = idx % variant.width;
  return String.fromCharCode(97 + x) + (Math.floor(idx / variant.width) + 1);
}

// Whether `team` could still win if the other side ran out of time.
export function canWinOnTime(state, team) {
  const { variant, board } = state;
  if (variant.flagAlwaysLoses) return true;
  return board.some((p) => p && p.type !== 'k' && teamOf(variant, p.seat) === team);
}

// Algebraic notation for a legal move (as returned by legalMoves/findMove).
export function toSan(state, move) {
  const { variant, board } = state;
  const w = variant.width;
  const p = board[move.from];
  const name = (i) => squareName(variant, i);
  let san;
  if (move.drop) {
    san = `${move.drop.toUpperCase()}@${name(move.to)}`;
  } else if (move.castle && move.castle.kingTo !== undefined) {
    san = move.castle.rookFrom > move.from ? 'O-O' : 'O-O-O';
  } else if (move.castle) {
    const span = Math.abs(move.castle.rookFrom - move.from);
    san = (span >= w ? span / w : span) <= 3 ? 'O-O' : 'O-O-O';
    // With several kings, say which one castled: "O-O(m)".
    const side = Math.sign(move.to - move.from);
    const twin = (m) => m.castle && m.from !== move.from && Math.sign(m.to - m.from) === side;
    if (legalMoves(state).some(twin)) san += `(${name(move.from)[0]})`;
  } else if (p.type === 'p') {
    san = (move.capture !== undefined ? name(move.from)[0] + 'x' : '') + name(move.to);
    if (move.promotion) san += '=' + move.promotion.toUpperCase();
  } else {
    const rivals = legalMoves(state).filter(
      (m) => m.to === move.to && m.from !== undefined && m.from !== move.from && board[m.from].type === p.type,
    );
    let origin = '';
    if (rivals.length) {
      const file = name(move.from)[0];
      const rank = name(move.from).slice(1);
      if (rivals.every((m) => name(m.from)[0] !== file)) origin = file;
      else if (rivals.every((m) => name(m.from).slice(1) !== rank)) origin = rank;
      else origin = file + rank;
    }
    san = p.type.toUpperCase() + origin + (move.capture !== undefined ? 'x' : '') + name(move.to);
  }
  const after = status(play(state, move));
  if (after.reason === 'checkmate') san += '#';
  else if (after.check) san += '+';
  return san;
}

// What a client needs to draw the position and generate moves.
export function serialize(state) {
  const data = {
    variant: state.variant.id,
    board: state.board,
    turn: state.turn,
    ep: state.ep,
    halfmove: state.halfmove,
  };
  if (state.checks) data.checks = state.checks;
  if (state.pockets) data.pockets = state.pockets;
  return data;
}

export function deserialize(data, variant) {
  const state = { variant, board: data.board, turn: data.turn, ep: data.ep, halfmove: data.halfmove, history: [] };
  if (data.checks) state.checks = data.checks;
  if (data.pockets) state.pockets = data.pockets;
  return state;
}

// Builds a state from a FEN string. Only for 8x8 variants with two seats
// (white = seat 0, black = seat 1); used for tests and set-up positions.
export function fromFEN(fen, variant) {
  const [placement, active = 'w', castling = '-', epSquare = '-', halfmove = '0'] = fen.trim().split(/\s+/);
  const w = variant.width;
  const board = new Array(w * variant.height).fill(null);
  placement.split('/').forEach((row, r) => {
    const y = variant.height - 1 - r;
    let x = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        x += Number(ch);
        continue;
      }
      const type = ch.toLowerCase();
      const seat = ch === type ? 1 : 0;
      const home = seat === 0 ? 0 : variant.height - 1;
      const rights = seat === 0 ? ['K', 'Q'] : ['k', 'q'];
      let moved = type === 'r';
      if (type === 'p') moved = y !== (seat === 0 ? 1 : variant.height - 2);
      else if (type === 'k') moved = !rights.some((c) => castling.includes(c));
      else if (type === 'r' && y === home) {
        moved = !((x === w - 1 && castling.includes(rights[0])) || (x === 0 && castling.includes(rights[1])));
      }
      board[y * w + x] = { type, seat, moved };
      x++;
    }
  });
  const turn = active === 'w' ? 0 : 1;
  let ep = null;
  if (epSquare !== '-') {
    const x = epSquare.charCodeAt(0) - 97;
    const y = Number(epSquare.slice(1)) - 1;
    const seat = 1 - turn;
    ep = { square: y * w + x, pawn: (y + variant.seats[seat].forward[1]) * w + x, seat };
  }
  return newState(variant, board, turn, ep, Number(halfmove));
}

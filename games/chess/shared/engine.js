// Rules engine shared by the server (the authority) and the browser (move
// hints). Nothing here assumes an 8x8 board or two players: geometry, seats,
// teams and turn order all come from the variant definition.
//
// A state is { variant, board, turn, ep, halfmove, history } and is never
// mutated; applyMove returns a new one. `board` is a flat array of
// { type, seat, moved } or null, indexed y * width + x.

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
  return `${key}|${state.turn}|${state.ep ? state.ep.square : ''}`;
}

export function createGame(variant) {
  const board = new Array(variant.width * variant.height).fill(null);
  for (const p of variant.setup) {
    board[p.y * variant.width + p.x] = { type: p.type, seat: p.seat, moved: false };
  }
  const state = { variant, board, turn: 0, ep: null, halfmove: 0, history: [] };
  state.history = [positionKey(state)];
  return state;
}

// Is the square attacked by any piece that is not on `team`?
function isAttacked(state, idx, team) {
  const { variant, board } = state;
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
            (p.type === 'q' || p.type === slider || (dist === 1 && p.type === 'k'))) {
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

export function inCheck(state, team) {
  return kingSquares(state, team).some((i) => isAttacked(state, i, team));
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
        if (!p.moved && inside(x2, y2) && !board[y2 * w + x2]) {
          moves.push({ from, to: y2 * w + x2, double: one });
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
        else if (isEnemy(target)) moves.push({ from, to, capture: to });
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

    // Castling: an unmoved king steps two squares towards an unmoved rook of
    // its own army along the back rank, with nothing in between, and the rook
    // lands on the square the king crossed. The king may not start on, cross
    // or land on an attacked square.
    if (p.type === 'k' && !p.moved && !isAttacked(state, from, team)) {
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
        if (isAttacked(state, rookTo, team) || isAttacked(state, to, team)) continue;
        moves.push({ from, to, castle: { rookFrom, rookTo } });
      }
    }
  }
  return moves;
}

// Plays a move without checking legality or recording history.
function play(state, move) {
  const board = state.board.slice();
  const p = board[move.from];
  const captured = move.capture !== undefined;
  if (captured) board[move.capture] = null;
  board[move.from] = null;
  board[move.to] = { type: move.promotion || p.type, seat: p.seat, moved: true };
  if (move.castle) {
    const rook = board[move.castle.rookFrom];
    board[move.castle.rookFrom] = null;
    board[move.castle.rookTo] = { type: rook.type, seat: rook.seat, moved: true };
  }
  return {
    variant: state.variant,
    board,
    turn: (state.turn + 1) % state.variant.turnOrder.length,
    ep: move.double !== undefined ? { square: move.double, pawn: move.to, seat: p.seat } : null,
    halfmove: p.type === 'p' || captured ? 0 : state.halfmove + 1,
    history: state.history,
  };
}

// Legal moves for the seat to move, optionally only for the piece on `from`.
// A move is legal when it leaves no king of the mover's team attacked.
export function legalMoves(state, from) {
  const seat = seatToMove(state);
  const team = teamOf(state.variant, seat);
  return pseudoMoves(state, seat, from).filter((m) => !inCheck(play(state, m), team));
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
    if (p.type === 'k' && !p.moved) {
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

// Resolves { from, to, promotion } to the full legal move, or null.
export function findMove(state, { from, to, promotion } = {}) {
  if (!Number.isInteger(from) || from < 0 || from >= state.board.length) return null;
  return legalMoves(state, from).find((m) => m.to === to && m.promotion === (promotion || undefined)) || null;
}

// Returns the state after the move, or null if the move is not legal.
export function applyMove(state, move) {
  const legal = findMove(state, move);
  if (!legal) return null;
  const next = play(state, legal);
  next.history = [...state.history, positionKey(next)];
  return next;
}

function insufficientMaterial(state) {
  const { variant, board } = state;
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
  if (legalMoves(state).length === 0) {
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

// Algebraic notation for a legal move (as returned by legalMoves/findMove).
export function toSan(state, move) {
  const { variant, board } = state;
  const w = variant.width;
  const p = board[move.from];
  const name = (i) => squareName(variant, i);
  let san;
  if (move.castle) {
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
      (m) => m.to === move.to && m.from !== move.from && board[m.from].type === p.type,
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
  return {
    variant: state.variant.id,
    board: state.board,
    turn: state.turn,
    ep: state.ep,
    halfmove: state.halfmove,
  };
}

export function deserialize(data, variant) {
  return { variant, board: data.board, turn: data.turn, ep: data.ep, halfmove: data.halfmove, history: [] };
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
  const state = { variant, board, turn, ep, halfmove: Number(halfmove), history: [] };
  state.history = [positionKey(state)];
  return state;
}

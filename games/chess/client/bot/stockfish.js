// Stockfish as a bot: the engine in ../stockfish runs as a worker and is
// spoken to in UCI, one line per message. It knows standard chess and
// Chess960 only.

import { variants } from '../../shared/variants.js';
import { createGame, squareName } from '../../shared/engine.js';

const ENGINE = new URL('../stockfish/stockfish-19-lite-single.js', import.meta.url);
// What each level allows the engine: its own "Skill Level" (0 to 20), how
// many moves ahead it may look and for how long.
const LEVELS = [
  { skill: 0, depth: 1, timeMs: 50 },
  { skill: 2, depth: 2, timeMs: 100 },
  { skill: 4, depth: 3, timeMs: 150 },
  { skill: 7, depth: 5, timeMs: 200 },
  { skill: 10, depth: 7, timeMs: 300 },
  { skill: 13, depth: 10, timeMs: 400 },
  { skill: 17, depth: 14, timeMs: 500 },
  { skill: 20, depth: 22, timeMs: 1000 },
];
const MATE_SCORE = 100_000;
// An engine that has not said a word by now did not load.
const START_TIMEOUT_MS = 20_000;

// The starting position in FEN. In Chess960 "KQkq" means the outermost rooks.
function startFen(variant, start) {
  const { board } = createGame(variant, start ?? undefined);
  const rows = [];
  for (let y = variant.height - 1; y >= 0; y--) {
    let row = '';
    let empty = 0;
    for (let x = 0; x < variant.width; x++) {
      const p = board[y * variant.width + x];
      if (!p) {
        empty++;
        continue;
      }
      row += (empty || '') + (p.seat === 0 ? p.type.toUpperCase() : p.type);
      empty = 0;
    }
    rows.push(row + (empty || ''));
  }
  return `${rows.join('/')} w KQkq - 0 1`;
}

// Returns { think, stop, destroy }. `think` resolves with { move, score } as
// the worker in worker.js does, and rejects if the engine cannot be run.
export function createStockfish() {
  const worker = new Worker(ENGINE);
  let listener = null; // gets every line the engine prints
  let failed = null;
  let fail = () => {};
  worker.onmessage = ({ data }) => listener?.(String(data));
  worker.onerror = (e) => {
    e.preventDefault?.();
    failed = new Error(`Stockfish could not be started: ${e.message || 'unknown error'}`);
    fail(failed);
  };

  // Sends the commands and resolves with the first line that `done` accepts.
  const ask = (commands, done) => new Promise((resolve, reject) => {
    if (failed) return reject(failed);
    fail = reject;
    listener = (line) => {
      const result = done(line);
      if (result === undefined) return;
      listener = null;
      resolve(result);
    };
    for (const command of commands) worker.postMessage(command);
  });
  const said = (word) => (line) => (line === word ? true : undefined);

  // One question at a time: each waits for the answer to the one before.
  let queue = ask(['uci'], said('uciok'));
  const startTimer = setTimeout(() => worker.onerror({ message: 'no answer' }), START_TIMEOUT_MS);
  queue.then(() => clearTimeout(startTimer), () => clearTimeout(startTimer));

  function think({ variant: id, start, played, level, timeMs }) {
    const variant = variants[id];
    const limits = LEVELS[level - 1];
    const uci = (m) => squareName(variant, m.from) + squareName(variant, m.to) + (m.promotion || '');
    const answer = queue.then(async () => {
      await ask([
        `setoption name UCI_Chess960 value ${variant.castling === 'fischer'}`,
        `setoption name Skill Level value ${limits.skill}`,
        'isready',
      ], said('readyok'));
      let score = 0;
      const best = await ask([
        `position fen ${startFen(variant, start)} moves ${played.map(uci).join(' ')}`,
        `go depth ${limits.depth} movetime ${Math.max(10, Math.round(Math.min(timeMs, limits.timeMs)))}`,
      ], (line) => {
        const words = line.split(' ');
        const at = words.indexOf('score');
        if (words[0] === 'info' && at !== -1) {
          const n = Number(words[at + 2]);
          score = words[at + 1] === 'mate' ? Math.sign(n) * MATE_SCORE : n;
        }
        return words[0] === 'bestmove' ? words[1] : undefined;
      });
      const square = (name) => name.charCodeAt(0) - 97 + (Number(name[1]) - 1) * variant.width;
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(best)) return { move: null, score };
      return { move: { from: square(best.slice(0, 2)), to: square(best.slice(2, 4)), promotion: best[4] }, score };
    });
    // A failure is the caller's to deal with; the next question starts afresh.
    queue = answer.catch(() => {});
    return answer;
  }

  return {
    think,
    stop: () => worker.postMessage('stop'),
    destroy: () => worker.terminate(),
  };
}

// Statistics about the site, for the admin panel: counts per day, kept for
// good, and per hour for the last week. Nothing personal is kept: players'
// names are used only to count how many different people played today, and
// are forgotten when the day ends.
//
// With a data directory, finished days go to <dir>/stats.jsonl, one line
// each, and the day under way and the hours to <dir>/stats-current.json,
// written every minute and when the server stops, so a restart loses
// nothing. Days and hours are the server's local time.

import path from 'node:path';
import { readFile, writeFile, appendFile, rename, mkdir } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const HOURS_KEPT = 7 * 24;
// Option values counted per option; beyond this many the rest are ignored.
const MAX_VALUES = 50;
const SAMPLE_MS = 60_000;

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hourOf = (t) => `${dayOf(t)}T${pad(new Date(t).getHours())}`;

const newDay = (day) => ({
  day,
  players: 0, // different names that joined
  peakOnline: 0, // most players online at once
  connections: 0, // pages that connected
  dropped: 0, // players who lost their connection mid-game
  chat: 0, // chat messages
  games: {}, // per game, see newGame
  server: { starts: 0, updates: 0, errors: 0, lagMaxMs: 0, rssMaxMb: 0 },
});

const newGame = () => ({
  started: 0,
  finished: 0,
  vsBot: 0, // of those finished
  durationMs: 0, // of those finished, added up
  reasons: {}, // how they ended: { resign: 3, ... }
  options: {}, // what was chosen: { variant: { standard: 4 }, minutes: { 5: 2 } }
  bots: {}, // per bot level: { games, botWins, draws }
});

const newHour = (hour) => ({ hour, peakOnline: 0, players: 0, games: 0, lagMaxMs: 0, rssMaxMb: 0 });

export class Stats {
  // `version` is the commit the server runs, so that an update can be told
  // from a plain restart.
  constructor({ dir = null, now = Date.now, version = null } = {}) {
    this.dir = dir;
    this.now = now;
    this.version = version;
    this.history = []; // finished days, oldest first
    this.today = newDay(dayOf(now()));
    this.names = new Set(); // who joined today
    this.hours = [];
    this.online = 0;
    this.timers = [];
  }

  file(name) {
    return path.join(this.dir, name);
  }

  async load() {
    if (this.dir) {
      await mkdir(this.dir, { recursive: true });
      try {
        const text = await readFile(this.file('stats.jsonl'), 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            this.history.push(JSON.parse(line));
          } catch {
            console.warn('Skipping an unreadable line of stats.jsonl');
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      let current = null;
      try {
        current = JSON.parse(await readFile(this.file('stats-current.json'), 'utf8'));
      } catch {
        // A first start, or a file cut short: today starts afresh.
      }
      if (current?.today) {
        this.today = current.today;
        this.names = new Set(current.names ?? []);
        this.hours = current.hours ?? [];
      }
      // The day saved may have ended while the server was down.
      this.rollOver();
      if (this.version && current?.version && current.version !== this.version) this.today.server.updates++;
    }
    this.rollOver();
    this.today.server.starts++;
  }

  // Starts sampling memory and the event loop's delays, and saving every
  // minute. The timers do not keep the process alive.
  start() {
    const delay = monitorEventLoopDelay({ resolution: 20 });
    delay.enable();
    this.timers.push(setInterval(() => {
      this.sample(delay.max / 1e6, process.memoryUsage().rss / 2 ** 20);
      delay.reset();
      this.save().catch((err) => console.error('Could not save statistics:', err));
    }, SAMPLE_MS));
    for (const timer of this.timers) timer.unref();
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  // A day that has ended goes into the history, and the day under way
  // starts afresh. Returns the day's record.
  rollOver() {
    const day = dayOf(this.now());
    if (this.today.day !== day) {
      const finished = this.today;
      this.history.push(finished);
      if (this.dir) {
        appendFile(this.file('stats.jsonl'), `${JSON.stringify(finished)}\n`)
          .catch((err) => console.error('Could not save statistics:', err));
      }
      this.today = newDay(day);
      this.names = new Set();
    }
    return this.today;
  }

  hour() {
    const key = hourOf(this.now());
    let entry = this.hours[this.hours.length - 1];
    if (entry?.hour !== key) {
      entry = newHour(key);
      this.hours.push(entry);
      if (this.hours.length > HOURS_KEPT) this.hours.splice(0, this.hours.length - HOURS_KEPT);
      entry.peakOnline = this.online;
    }
    return entry;
  }

  game(id) {
    const games = this.rollOver().games;
    games[id] ??= newGame();
    return games[id];
  }

  // ---- what the lobby reports ----

  connected() {
    this.rollOver().connections++;
  }

  joined(name) {
    const day = this.rollOver();
    const key = name.toLowerCase();
    if (!this.names.has(key)) {
      this.names.add(key);
      day.players = this.names.size;
      this.hour().players++;
    }
  }

  // How many players are online now.
  onlineNow(count) {
    this.online = count;
    const day = this.rollOver();
    day.peakOnline = Math.max(day.peakOnline, count);
    const hour = this.hour();
    hour.peakOnline = Math.max(hour.peakOnline, count);
  }

  dropped() {
    this.rollOver().dropped++;
  }

  chat() {
    this.rollOver().chat++;
  }

  error() {
    this.rollOver().server.errors++;
  }

  matchStarted({ game, options }) {
    const g = this.game(game);
    g.started++;
    this.hour().games++;
    for (const [key, value] of Object.entries(options ?? {})) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) continue;
      const counts = (g.options[key] ??= {});
      const name = String(value);
      if (counts[name] === undefined && Object.keys(counts).length >= MAX_VALUES) continue;
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }

  // `bots` has the bot's settings in its seat, `over` is the match's result
  // ({ reason, winner }, winner a seat or null for a draw).
  matchEnded({ game, bots, over, durationMs }) {
    const g = this.game(game);
    g.finished++;
    g.durationMs += Math.max(0, durationMs);
    const reason = String(over?.reason ?? 'unknown');
    g.reasons[reason] = (g.reasons[reason] ?? 0) + 1;
    const botSeat = (bots ?? []).findIndex(Boolean);
    if (botSeat === -1) return;
    g.vsBot++;
    const level = String(bots[botSeat].level ?? '?');
    const record = (g.bots[level] ??= { games: 0, botWins: 0, draws: 0 });
    record.games++;
    if (over?.winner === null || over?.winner === undefined) record.draws++;
    else if (over.winner === botSeat) record.botWins++;
  }

  // The longest the event loop was held up and the memory in use, sampled.
  sample(lagMs, rssMb) {
    const { server } = this.rollOver();
    server.lagMaxMs = Math.max(server.lagMaxMs, Math.round(lagMs));
    server.rssMaxMb = Math.max(server.rssMaxMb, Math.round(rssMb));
    const hour = this.hour();
    hour.lagMaxMs = Math.max(hour.lagMaxMs, Math.round(lagMs));
    hour.rssMaxMb = Math.max(hour.rssMaxMb, Math.round(rssMb));
  }

  // ---- reading ----

  // The last `count` days, today included, oldest first.
  days(count) {
    this.rollOver();
    return [...this.history, this.today].slice(-count);
  }

  // The hours of the last week, oldest first.
  lastHours() {
    this.hour();
    return this.hours.slice();
  }

  // ---- keeping ----

  async save() {
    if (!this.dir) return;
    this.rollOver();
    const current = { version: this.version, today: this.today, names: [...this.names], hours: this.hours };
    const tmp = this.file('stats-current.json.tmp');
    await writeFile(tmp, JSON.stringify(current));
    await rename(tmp, this.file('stats-current.json'));
  }
}

// The two kinds of clock. Fischer: main time, plus an increment after every
// move. Byo-yomi: main time, then a number of periods; a move made within a
// period keeps it, and running past one uses it up.
//
// A clock is { ms, periods, byo }: the time left on the main time (or, once
// `byo`, in the current period) and the periods still in reserve after it.

export const periodMsOf = (options) => (options.clock === 'byoyomi' ? options.period * 1000 : 0);

export function initialClock(options) {
  const ms = Math.round(options.minutes * 60_000);
  if (options.clock !== 'byoyomi') return { ms, periods: 0, byo: false };
  // Without main time the first period starts at once.
  if (!ms) return { ms: options.period * 1000, periods: options.periods - 1, byo: true };
  return { ms, periods: options.periods, byo: false };
}

// The clock after `elapsed` ms of thinking. `ms` is 0 once it has run out.
export function spend(clock, elapsed, periodMs) {
  let { ms, periods, byo } = clock;
  ms -= elapsed;
  while (ms <= 0 && periods > 0) {
    ms += periodMs;
    periods--;
    byo = true;
  }
  return { ms: Math.max(0, ms), periods, byo };
}

// How long until the clock runs out.
export const timeLeft = (clock, periodMs) => clock.ms + clock.periods * periodMs;

// The clock once a move has been made after `elapsed` ms, or null if it ran
// out first.
export function afterMove(clock, elapsed, options) {
  const spent = spend(clock, elapsed, periodMsOf(options));
  if (!spent.ms) return null;
  if (spent.byo) spent.ms = periodMsOf(options);
  else if (options.clock !== 'byoyomi') spent.ms += options.increment * 1000;
  return spent;
}

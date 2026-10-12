// Sound effects. Each one is a recording from the Lichess standard sound set
// in /sound; until a recording has loaded, or if it cannot be, the effect is
// synthesised instead from a few short notes or knocks.

const MUTE_KEY = 'chess.muted';

// Which recording each effect plays. A check sounds like any other move, as
// it does on Lichess.
const FILES = {
  move: 'Move',
  check: 'Move',
  capture: 'Capture',
  start: 'GenericNotify',
  end: 'GenericNotify',
  notify: 'SocialNotify',
  lowTime: 'LowTime',
  explosion: 'Explosion',
};

let ctx = null;
let noise = null;
const recordings = new Map(); // file name -> decoded AudioBuffer
let muted = false;
try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch {
  // Without storage the choice just does not survive a reload.
}

function context() {
  if (!ctx) {
    ctx = new AudioContext();
    const length = Math.floor(ctx.sampleRate * 0.2);
    noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    for (const file of new Set(Object.values(FILES))) loadRecording(file);
  }
  return ctx;
}

async function loadRecording(file) {
  try {
    const response = await fetch(`/sound/${file}.mp3`);
    if (!response.ok) return;
    recordings.set(file, await ctx.decodeAudioData(await response.arrayBuffer()));
  } catch {
    // The synthesised effect stands in.
  }
}

// The effects that have their recording ready.
export const recorded = () => Object.keys(FILES).filter((name) => recordings.has(FILES[name]));

// Browsers keep audio suspended until the user interacts with the page.
for (const event of ['pointerdown', 'keydown']) {
  window.addEventListener(event, () => {
    if (!muted) context().resume();
  }, { capture: true });
}

function envelope(t, peak, decay) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(peak, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + decay);
  gain.connect(ctx.destination);
  return gain;
}

// A piece landing on wood: a burst of filtered noise over a low thump.
function knock(t, freq, peak, decay) {
  const click = ctx.createBufferSource();
  click.buffer = noise;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  click.connect(filter).connect(envelope(t, peak, decay));
  click.start(t);
  click.stop(t + decay);

  const thump = ctx.createOscillator();
  thump.frequency.setValueAtTime(freq / 5, t);
  thump.frequency.exponentialRampToValueAtTime(freq / 12, t + decay);
  thump.connect(envelope(t, peak * 0.8, decay));
  thump.start(t);
  thump.stop(t + decay);
}

function note(t, freq, duration, peak = 0.14, type = 'sine') {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(envelope(t, peak, duration));
  osc.start(t);
  osc.stop(t + duration);
}

const SOUNDS = {
  move: (t) => knock(t, 1100, 0.5, 0.08),
  capture: (t) => {
    knock(t, 1700, 0.7, 0.05);
    knock(t + 0.05, 800, 0.65, 0.11);
  },
  check: (t) => {
    knock(t, 1100, 0.5, 0.08);
    note(t + 0.04, 932, 0.22, 0.13, 'triangle');
  },
  start: (t) => [523, 659, 784].forEach((f, i) => note(t + i * 0.09, f, 0.25)),
  end: (t) => [784, 659, 523, 392].forEach((f, i) => note(t + i * 0.13, f, 0.4)),
  // An invitation or a draw offer.
  notify: (t) => [880, 1175].forEach((f, i) => note(t + i * 0.12, f, 0.3)),
  lowTime: (t) => [0, 0.16].forEach((d) => note(t + d, 1245, 0.09, 0.07, 'square')),
  explosion: (t) => {
    knock(t, 500, 0.9, 0.3);
    knock(t + 0.03, 220, 0.9, 0.5);
  },
};

// `delay` is in seconds, for a sound that should follow another one.
export function play(name, delay = 0) {
  if (muted) return;
  try {
    // Skip rather than queue while suspended, or everything missed would
    // play at once on the first click.
    if (context().state !== 'running') return;
    const t = ctx.currentTime + 0.01 + delay;
    const recording = recordings.get(FILES[name]);
    if (!recording) {
      SOUNDS[name](t);
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = recording;
    source.connect(ctx.destination);
    source.start(t);
  } catch {
    // Sound is a nicety; never let it break the game.
  }
}

export const isMuted = () => muted;

export function setMuted(value) {
  muted = value;
  try {
    localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    // See above.
  }
}

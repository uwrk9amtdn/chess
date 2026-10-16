// The battlefield on a canvas, and the controls. Snapshots come 20 times a
// second; in between, the player's own tank is moved at once by the same
// physics the server runs (and pulled back if the two disagree), the other
// tank glides toward where the server last put it, and shells fly on by
// themselves, since they never change speed.
//
// Keyboard: WASD or the arrows drive, Space fires. Mouse: the turret
// follows the pointer and the left button fires. Touch: a stick appears
// wherever the left half of the arena is touched, to drive, and one on the
// right half aims and fires while it is held; a tap there fires once.

import {
  BARREL_LENGTH, BULLET_RADIUS, FIRE_COOLDOWN, MAP_H, MAP_W, MAX_HP, TANK_COLOURS, TANK_RADIUS, TURRET_TURN_SPEED,
} from '../shared/constants.js';
import { WALLS } from '../shared/map.js';
import {
  NO_INPUT, circleHitsCircle, driveToward, moveTank, rotateTowards, stepBullet, wrapAngle,
} from '../shared/physics.js';
import { el } from '/js/kit/dom.js';

// How quickly a tank shown catches up with the server (higher is snappier).
const INTERPOLATION_RATE = 12;
// Our own tank is put back where the server has it once it is this far off.
const SNAP_DISTANCE = 48;
const SNAP_ANGLE = 0.6;
// A shell further than this from where the server has it is moved there.
const SHELL_SNAP = 30;
const AIM_SEND_INTERVAL_MS = 50;
const STICK_RADIUS = 60;
const STICK_DEAD_ZONE = 12;
const TAP_MS = 250;
const DEAD_COLOUR = '#555';
const DARK = '#1b1f29';
const SHELL_COLOUR = '#fff3b0';
const KEYS = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
};

const lerp = (a, b, t) => a + (b - a) * t;

// A darker shade of a '#rrggbb' colour.
function darken(hex, by = 0.25) {
  const n = parseInt(hex.slice(1), 16);
  const part = (shift) => Math.round(((n >> shift) & 255) * (1 - by));
  return `rgb(${part(16)}, ${part(8)}, ${part(0)})`;
}

// "1:45"
const formatTime = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// `send(action)` sends an action of the player's own seat. `banner(game)`
// gives the words written across the arena, if any: { big, small }.
export function createArena(root, { send, banner }) {
  const canvas = el('canvas', { className: 'tanksCanvas' });
  root.replaceChildren(canvas);
  const g = canvas.getContext('2d');

  let game = null;
  let gameAt = 0; // performance.now() when it arrived, to count down between snapshots
  // What is drawn for each seat: { x, y, hull, turret }.
  let shown = [];
  // The shells being flown here, by id: { body, owner, done }.
  const shells = new Map();
  // Flashes where a tank was hit: { x, y, at, big }.
  const blasts = [];
  let playingSince = null; // when the current fighting began, for "GO!"

  // ---- the controls ----

  const held = { left: false, right: false, up: false, down: false };
  let pointer = null; // the mouse in arena coordinates
  let mouseDown = false;
  let spaceDown = false;
  let moveStick = null; // { id, ox, oy, x, y }
  let aimStick = null; // { id, ox, oy, x, y, at }
  let aim = null; // the angle the turret should point at, once one is chosen
  let lastSent = { ...NO_INPUT };
  let lastSentAt = 0;
  let lastFireAt = 0;

  const playing = () => Boolean(game && game.you !== null && !game.over);
  const fighting = () => Boolean(game && game.phase === 'playing' && !game.paused && !game.over);

  function toArena(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: ((e.clientX - rect.left) / rect.width) * MAP_W, y: ((e.clientY - rect.top) / rect.height) * MAP_H };
  }

  function onKey(e) {
    if (!playing() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, dialog')) return;
    const down = e.type === 'keydown';
    if (KEYS[e.code]) held[KEYS[e.code]] = down;
    else if (e.code === 'Space') spaceDown = down;
    else return;
    // Not the page scrolling as well.
    e.preventDefault();
  }
  function letGo() {
    for (const key of Object.keys(held)) held[key] = false;
    spaceDown = mouseDown = false;
    moveStick = aimStick = null;
  }

  function onPointerDown(e) {
    if (!playing()) return;
    const p = toArena(e);
    if (e.pointerType === 'mouse') {
      pointer = p;
      if (e.button === 0) mouseDown = true;
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    const stick = { id: e.pointerId, ox: p.x, oy: p.y, x: p.x, y: p.y, at: performance.now() };
    if (p.x < MAP_W / 2) moveStick ??= stick;
    else aimStick ??= stick;
    e.preventDefault();
  }
  function onPointerMove(e) {
    const p = toArena(e);
    if (e.pointerType === 'mouse') pointer = p;
    for (const stick of [moveStick, aimStick]) {
      if (stick && stick.id === e.pointerId) Object.assign(stick, p);
    }
  }
  function onPointerUp(e) {
    if (e.pointerType === 'mouse' && e.button === 0) mouseDown = false;
    if (moveStick?.id === e.pointerId) moveStick = null;
    if (aimStick?.id === e.pointerId) {
      // A quick tap that hardly moved fires where the turret points.
      const tap = Math.hypot(aimStick.x - aimStick.ox, aimStick.y - aimStick.oy) < STICK_DEAD_ZONE &&
        performance.now() - aimStick.at < TAP_MS;
      aimStick = null;
      if (tap) fire(performance.now());
    }
  }
  const stickAngle = (s) => (s && Math.hypot(s.x - s.ox, s.y - s.oy) >= STICK_DEAD_ZONE ? Math.atan2(s.y - s.oy, s.x - s.ox) : null);

  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', letGo);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') mouseDown = false;
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function fire(now) {
    if (!fighting() || now - lastFireAt < FIRE_COOLDOWN * 1000 + 30) return;
    lastFireAt = now;
    send({ action: 'fire' });
  }

  // What the player is asking for now, sent when it changes (the aim no
  // more often than every AIM_SEND_INTERVAL_MS), and a shot while the
  // trigger is held: the server keeps the real cooldown.
  function readControls(now, me) {
    const touchAim = stickAngle(aimStick);
    if (touchAim !== null) aim = touchAim;
    else if (pointer && me) aim = Math.atan2(pointer.y - me.y, pointer.x - me.x);
    const stick = driveToward(stickAngle(moveStick));
    const input = {
      left: held.left || stick.left,
      right: held.right || stick.right,
      up: held.up || stick.up,
      down: held.down || stick.down,
      aim: aim ?? me?.turret ?? 0,
    };
    const moved = ['left', 'right', 'up', 'down'].some((k) => input[k] !== lastSent[k]);
    const turned = Math.abs(wrapAngle(input.aim - lastSent.aim)) > 0.01;
    if (moved || (turned && now - lastSentAt >= AIM_SEND_INTERVAL_MS)) {
      send({ action: 'input', ...input });
      lastSent = input;
      lastSentAt = now;
    }
    if (mouseDown || spaceDown || touchAim !== null) fire(now);
    return input;
  }

  // ---- following the server ----

  function update(snapshot) {
    const fresh = !game || game.id !== snapshot.id;
    const before = game;
    game = snapshot;
    gameAt = performance.now();
    canvas.classList.toggle('controls', playing());
    if (!playing()) letGo();

    // A new match, or a new round, starts with everything where it is.
    if (fresh || shown.length !== game.tanks.length || (before.phase !== 'countdown' && game.phase === 'countdown' && !game.paused)) {
      shown = game.tanks.map((t) => ({ x: t.x, y: t.y, hull: t.hull, turret: t.turret }));
      shells.clear();
      if (fresh) aim = null;
    }
    if (game.phase === 'playing' && before?.phase !== 'playing') playingSince = gameAt;
    else if (game.phase !== 'playing') playingSince = null;

    // A flash where a tank lost armour.
    if (!fresh) {
      game.tanks.forEach((t, seat) => {
        const was = before.tanks[seat];
        if (was && t.hp < was.hp) blasts.push({ x: t.x, y: t.y, at: gameAt, big: t.hp === 0 });
      });
    }

    // Shells: new ones start where the server has them, gone ones go, and
    // the others fly on here unless they are too far off.
    const ids = new Set(game.bullets.map((b) => b.id));
    for (const id of shells.keys()) if (!ids.has(id)) shells.delete(id);
    for (const b of game.bullets) {
      const shell = shells.get(b.id);
      if (!shell || Math.hypot(shell.body.x - b.x, shell.body.y - b.y) > SHELL_SNAP) {
        shells.set(b.id, { body: { x: b.x, y: b.y, vx: b.vx, vy: b.vy, bounces: b.bounces }, owner: b.owner, done: false });
      }
    }
  }

  // ---- each frame ----

  let lastFrame = performance.now();
  let frame = requestAnimationFrame(tick);

  function tick(now) {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    if (!game) return;
    resize();
    const live = fighting();
    game.tanks.forEach((server, seat) => {
      const view = shown[seat];
      if (seat === game.you && live && server.hp) predict(view, server, now, dt);
      else follow(view, server, live ? Math.min(1, INTERPOLATION_RATE * dt) : 1);
    });
    if (playing() && !(live && game.tanks[game.you].hp)) readControls(now, shown[game.you]);
    if (live) flyShells(dt);
    draw(now);
  }

  // Our own tank moves as soon as a key is pressed, and is then kept close to
  // where the server says it is.
  function predict(view, server, now, dt) {
    const input = readControls(now, view);
    const others = shown.filter((t, seat) => seat !== game.you && game.tanks[seat].hp);
    const pos = { x: view.x, y: view.y };
    const heading = moveTank(pos, input, dt, others);
    if (heading !== null) view.hull = heading;
    if (Math.hypot(pos.x - server.x, pos.y - server.y) > SNAP_DISTANCE) Object.assign(pos, { x: server.x, y: server.y });
    else if (heading === null) {
      const t = Math.min(1, INTERPOLATION_RATE * dt);
      pos.x = lerp(pos.x, server.x, t);
      pos.y = lerp(pos.y, server.y, t);
    }
    view.x = pos.x;
    view.y = pos.y;
    view.turret = rotateTowards(view.turret, input.aim, TURRET_TURN_SPEED * dt);
    if (Math.abs(wrapAngle(view.turret - server.turret)) > SNAP_ANGLE) view.turret = server.turret;
  }

  function follow(view, server, t) {
    view.x = lerp(view.x, server.x, t);
    view.y = lerp(view.y, server.y, t);
    view.hull += wrapAngle(server.hull - view.hull) * t;
    view.turret += wrapAngle(server.turret - view.turret) * t;
  }

  function flyShells(dt) {
    for (const shell of shells.values()) {
      if (shell.done) continue;
      const b = shell.body;
      const hit = () => game.tanks.some((t, seat) => t.hp && (seat !== shell.owner || b.bounces > 0) &&
        circleHitsCircle(b, BULLET_RADIUS, shown[seat], TANK_RADIUS));
      // Hidden once it has hit something here; the server says if it did.
      if (!stepBullet(b, dt) || hit()) shell.done = true;
    }
  }

  // ---- drawing ----

  // The theme's colours, read again whenever the page changes theme.
  let colours = null;
  const readColours = () => {
    const css = getComputedStyle(root);
    const get = (name) => css.getPropertyValue(name).trim();
    colours = { grid: get('--border'), wall: get('--muted') };
  };
  const themeWatch = new MutationObserver(() => {
    colours = null;
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  let size = { w: 0, h: 0, ratio: 0 };
  function resize() {
    const ratio = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === size.w && h === size.h && ratio === size.ratio) return;
    size = { w, h, ratio };
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
  }

  // Words and marks are kept from getting too small to read on a small screen.
  let textScale = 1;

  function draw(now) {
    if (!colours) readColours();
    textScale = Math.max(1, 0.8 / (canvas.clientWidth / MAP_W));
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / MAP_W;
    g.setTransform(scale, 0, 0, scale, 0, 0);

    // A faint grid on the floor, and the walls.
    g.globalAlpha = 0.5;
    g.strokeStyle = colours.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 40; x < MAP_W; x += 40) g.moveTo(x, 0), g.lineTo(x, MAP_H);
    for (let y = 40; y < MAP_H; y += 40) g.moveTo(0, y), g.lineTo(MAP_W, y);
    g.stroke();
    g.globalAlpha = 1;
    // As one shape, so that where walls meet a see-through colour (the
    // Glass theme's) is not laid on twice.
    g.fillStyle = colours.wall;
    g.beginPath();
    for (const w of WALLS) g.rect(w.x, w.y, w.w, w.h);
    g.fill();

    // The dead below the living, and our own tank on top.
    const order = game.tanks.map((_, seat) => seat)
      .sort((a, b) => Boolean(game.tanks[a].hp) - Boolean(game.tanks[b].hp) || (a === game.you) - (b === game.you));
    for (const seat of order) drawTank(seat);

    g.fillStyle = SHELL_COLOUR;
    g.strokeStyle = '#000';
    g.lineWidth = 1;
    for (const shell of shells.values()) {
      if (shell.done) continue;
      g.beginPath();
      g.arc(shell.body.x, shell.body.y, BULLET_RADIUS, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }

    drawBlasts(now);
    drawSticks();
    drawWords(now);
  }

  function drawTank(seat) {
    const view = shown[seat];
    const { hp } = game.tanks[seat];
    const colour = hp ? TANK_COLOURS[seat] : DEAD_COLOUR;
    g.save();
    g.translate(view.x, view.y);
    g.globalAlpha = hp ? 1 : 0.45;
    g.save();
    g.rotate(view.hull);
    g.fillStyle = colour;
    g.strokeStyle = DARK;
    g.lineWidth = 3;
    g.fillRect(-18, -15, 36, 30);
    g.strokeRect(-18, -15, 36, 30);
    // Tracks along both sides, so it can be seen which way it drives.
    g.fillStyle = DARK;
    g.fillRect(-18, -15, 36, 5);
    g.fillRect(-18, 10, 36, 5);
    g.restore();
    g.save();
    g.rotate(view.turret);
    g.fillStyle = DARK;
    g.fillRect(0, -4, BARREL_LENGTH + 4, 8);
    g.beginPath();
    g.arc(0, 0, 11, 0, Math.PI * 2);
    g.fillStyle = darken(colour);
    g.fill();
    g.lineWidth = 2;
    g.stroke();
    g.restore();

    // The name and, under it, the armour left: above the tank, or below it
    // at the top edge.
    const ts = textScale;
    const font = 14 * ts;
    const pipH = 4 * ts;
    const below = view.y < 60 * ts;
    const pipY = below ? TANK_RADIUS + 6 : -TANK_RADIUS - 6 - pipH;
    const textY = below ? pipY + pipH + 3 + font / 2 : pipY - 3 - font / 2;
    const name = game.players[seat] + (seat === game.you ? ' (you)' : '');
    g.font = `600 ${font}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 2.5 * ts;
    g.strokeStyle = '#000';
    g.strokeText(name, 0, textY);
    g.fillStyle = seat === game.you ? '#ffe066' : '#fff';
    g.fillText(name, 0, textY);
    const pip = 10 * ts;
    const gap = 3 * ts;
    const left = -((pip + gap) * MAX_HP - gap) / 2;
    for (let k = 0; k < MAX_HP; k++) {
      g.fillStyle = k < hp ? '#4cd964' : '#3a3f4b';
      g.fillRect(left + k * (pip + gap), pipY, pip, pipH);
    }
    g.restore();
  }

  function drawBlasts(now) {
    while (blasts.length && now - blasts[0].at > 600) blasts.shift();
    for (const b of blasts) {
      const t = (now - b.at) / 600;
      g.globalAlpha = 1 - t;
      g.fillStyle = b.big ? '#ff7a30' : '#ffd36b';
      g.beginPath();
      g.arc(b.x, b.y, (b.big ? 20 : 10) + t * (b.big ? 50 : 22), 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  function drawSticks() {
    for (const s of [moveStick, aimStick]) {
      if (!s) continue;
      g.globalAlpha = 0.35;
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(s.ox, s.oy, STICK_RADIUS, 0, Math.PI * 2);
      g.fill();
      const d = Math.hypot(s.x - s.ox, s.y - s.oy);
      const k = d > STICK_RADIUS ? STICK_RADIUS / d : 1;
      g.globalAlpha = 0.6;
      g.beginPath();
      g.arc(s.ox + (s.x - s.ox) * k, s.oy + (s.y - s.oy) * k, 26, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // The countdown, "GO!", the end of a round, and the time left.
  function drawWords(now) {
    const elapsed = now - gameAt;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.strokeStyle = '#000';
    g.fillStyle = '#fff';
    g.lineJoin = 'round';
    const write = (text, y, px, stroke) => {
      g.font = `700 ${px}px system-ui, sans-serif`;
      g.lineWidth = stroke;
      g.strokeText(text, MAP_W / 2, y);
      g.fillText(text, MAP_W / 2, y);
    };
    if (game.phase === 'playing' && !game.over) {
      const left = game.paused ? game.roundMsLeft : Math.max(0, game.roundMsLeft - elapsed);
      write(formatTime(left), 30 + 14 * textScale, 22 * textScale, 4 * textScale);
    }
    let words = banner(game);
    if (game.phase === 'countdown' && !game.paused && !game.over) {
      words = { big: String(Math.max(1, Math.ceil((game.phaseMsLeft - elapsed) / 1000))), small: words?.small ?? '' };
    } else if (playingSince !== null && now - playingSince < 800 && !game.paused) words = { big: 'GO!', small: '' };
    if (!words) return;
    if (words.big) write(words.big, MAP_H / 2 - 20, words.big.length > 3 ? 64 : 120, 8);
    if (words.small) write(words.small, MAP_H / 2 + 70, 26 * textScale, 4 * textScale);
  }

  return {
    update,
    destroy() {
      cancelAnimationFrame(frame);
      themeWatch.disconnect();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', letGo);
      root.replaceChildren();
    },
  };
}

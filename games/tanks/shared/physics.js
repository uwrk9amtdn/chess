// How tanks and shells move and collide. The server runs this as the truth;
// the browser runs the same steps to show its own tank and the shells
// smoothly between snapshots, and the bot to try shots out.

import { BULLET_RADIUS, MAX_BOUNCES, TANK_RADIUS, TANK_SPEED } from './constants.js';
import { WALLS } from './map.js';

export const NO_INPUT = Object.freeze({ left: false, right: false, up: false, down: false, aim: 0 });

export function circleHitsRect(c, radius, r) {
  const cx = Math.max(r.x, Math.min(c.x, r.x + r.w));
  const cy = Math.max(r.y, Math.min(c.y, r.y + r.h));
  return (c.x - cx) ** 2 + (c.y - cy) ** 2 < radius * radius;
}

export function circleHitsCircle(a, ra, b, rb) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 < (ra + rb) ** 2;
}

export const circleHitsAnyWall = (c, radius) => WALLS.some((w) => circleHitsRect(c, radius, w));

// Pushes a circle out of a rectangle it overlaps.
function pushOutOfRect(pos, radius, r) {
  const cx = Math.max(r.x, Math.min(pos.x, r.x + r.w));
  const cy = Math.max(r.y, Math.min(pos.y, r.y + r.h));
  const dx = pos.x - cx;
  const dy = pos.y - cy;
  const dist = Math.hypot(dx, dy);
  if (dist >= radius) return;
  if (dist > 0) {
    pos.x += (dx / dist) * (radius - dist);
    pos.y += (dy / dist) * (radius - dist);
    return;
  }
  // The centre is inside: leave through the nearest edge.
  const exits = [
    { d: pos.x - r.x + radius, x: r.x - radius, y: pos.y },
    { d: r.x + r.w - pos.x + radius, x: r.x + r.w + radius, y: pos.y },
    { d: pos.y - r.y + radius, x: pos.x, y: r.y - radius },
    { d: r.y + r.h - pos.y + radius, x: pos.x, y: r.y + r.h + radius },
  ];
  const best = exits.reduce((a, b) => (b.d < a.d ? b : a));
  pos.x = best.x;
  pos.y = best.y;
}

function resolveCollisions(pos, others) {
  for (const other of others) {
    const dx = pos.x - other.x;
    const dy = pos.y - other.y;
    const dist = Math.hypot(dx, dy);
    const min = TANK_RADIUS * 2;
    if (dist > 0 && dist < min) {
      pos.x += (dx / dist) * (min - dist);
      pos.y += (dy / dist) * (min - dist);
    }
  }
  // Walls last, so no tank is ever pushed into one.
  for (const wall of WALLS) pushOutOfRect(pos, TANK_RADIUS, wall);
}

// Moves a tank one step in one of eight directions, against walls and the
// `others` tanks. Returns the direction it went in, or null if it was not
// asked to move.
export function moveTank(pos, input, dt, others = []) {
  let dx = Number(input.right) - Number(input.left);
  let dy = Number(input.down) - Number(input.up);
  if (dx === 0 && dy === 0) return null;
  if (dx !== 0 && dy !== 0) {
    dx *= Math.SQRT1_2;
    dy *= Math.SQRT1_2;
  }
  pos.x += dx * TANK_SPEED * dt;
  resolveCollisions(pos, others);
  pos.y += dy * TANK_SPEED * dt;
  resolveCollisions(pos, others);
  return Math.atan2(dy, dx);
}

// An angle in [-PI, PI).
export function wrapAngle(a) {
  return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

// The one of the eight ways to drive that is closest to `angle`, as the
// keys of an input; no keys for null.
export function driveToward(angle) {
  if (angle === null) return { left: false, right: false, up: false, down: false };
  const sector = Math.round(wrapAngle(angle) / (Math.PI / 4));
  const dx = Math.round(Math.cos((sector * Math.PI) / 4));
  const dy = Math.round(Math.sin((sector * Math.PI) / 4));
  return { left: dx < 0, right: dx > 0, up: dy < 0, down: dy > 0 };
}

// Turns `current` toward `target` by at most `maxStep`, the short way round.
export function rotateTowards(current, target, maxStep) {
  const diff = wrapAngle(target - current);
  if (Math.abs(diff) <= maxStep) return wrapAngle(target);
  return wrapAngle(current + Math.sign(diff) * maxStep);
}

// Fast shells move in steps of this many pixels, so none passes through a wall.
const BULLET_SUBSTEP = 4;

// Moves a shell { x, y, vx, vy, bounces } on at its constant speed. A wall
// turns it back along the axis it hit; a wall after MAX_BOUNCES ends it.
// Returns false once it is gone.
export function stepBullet(b, dt) {
  const distance = Math.hypot(b.vx, b.vy) * dt;
  const steps = Math.max(1, Math.ceil(distance / BULLET_SUBSTEP));
  const sdt = dt / steps;
  for (let i = 0; i < steps; i++) {
    let bounced = false;
    b.x += b.vx * sdt;
    if (circleHitsAnyWall(b, BULLET_RADIUS)) {
      b.x -= b.vx * sdt;
      b.vx = -b.vx;
      bounced = true;
    }
    b.y += b.vy * sdt;
    if (circleHitsAnyWall(b, BULLET_RADIUS)) {
      b.y -= b.vy * sdt;
      b.vy = -b.vy;
      bounced = true;
    }
    if (bounced && ++b.bounces > MAX_BOUNCES) return false;
  }
  return true;
}

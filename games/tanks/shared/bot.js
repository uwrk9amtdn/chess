// The computer opponent. It sees what a player sees, the snapshots, and
// answers with what a player sends: which way to drive, where to aim and
// when to fire. It finds its way along a grid of the arena, makes for a spot
// from which it can shoot without coming too close, leads a moving target,
// from level 4 on also tries shots off a wall, and from level 3 on steps out
// of the way of shells coming at it. The lower levels think more slowly,
// aim worse and dodge less often.

import {
  BARREL_LENGTH, BULLET_RADIUS, BULLET_SPEED, FIRE_COOLDOWN, MAP_H, MAP_W, TANK_RADIUS, TANK_SPEED,
} from './constants.js';
import { WALLS } from './map.js';
import { circleHitsAnyWall, circleHitsCircle, driveToward, stepBullet, wrapAngle } from './physics.js';

export const BOT_LEVELS = 8;

// Per level, from 1 to 8: how often it thinks again, how far off it aims
// (radians, either way), and how likely it is to dodge a shell.
const THINK_MS = [700, 550, 420, 330, 260, 200, 150, 100];
const AIM_ERROR = [0.3, 0.22, 0.15, 0.1, 0.07, 0.045, 0.025, 0.012];
const DODGE = [0, 0, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95];
// From these levels on it leads a moving target, picks its ground, and
// tries ricochets.
const LEADS_FROM = 3;
const TACTICS_FROM = 3;
const RICOCHETS_FROM = 4;

// The distance it likes to fight at.
const NEAR = 220;
const FAR = 460;
// The turret is close enough to where it should point to fire.
const AIM_TOLERANCE = 0.06;
const RICOCHET_ANGLES = 120;
const SWEEP_PART = 30; // angles tried in one turn of thinking
const SHOT_STEP = 0.02; // seconds per step when trying a shot out
const SHOT_TIME = 2.2; // how long a shot is followed
const DODGE_LOOKAHEAD = 0.7;

// ---- the grid it drives on ----

const CELL = 20;
const COLS = MAP_W / CELL;
const ROWS = MAP_H / CELL;
const cellOf = ({ x, y }) => Math.min(ROWS - 1, Math.max(0, Math.floor(y / CELL))) * COLS +
  Math.min(COLS - 1, Math.max(0, Math.floor(x / CELL)));
const centreOf = (c) => ({ x: (c % COLS) * CELL + CELL / 2, y: Math.floor(c / COLS) * CELL + CELL / 2 });

// The cells a tank fits in, with a little room to spare, worked out once.
let free = null;
function freeCells() {
  free ??= Array.from({ length: COLS * ROWS }, (_, c) => !circleHitsAnyWall(centreOf(c), TANK_RADIUS + 3));
  return free;
}

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// How far each cell is from `start`, by way of free cells, and the cell
// each was reached from.
function distances(start) {
  const open = freeCells();
  const dist = new Float64Array(COLS * ROWS).fill(Infinity);
  const from = new Int32Array(COLS * ROWS).fill(-1);
  // Cells near the start may be blocked when the tank is pressed to a wall.
  dist[start] = 0;
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const cx = c % COLS;
    const cy = Math.floor(c / COLS);
    for (const [dx, dy] of STEPS) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) continue;
      const n = y * COLS + x;
      // A diagonal step may not cut a corner.
      if (!open[n] || (dx && dy && (!open[cy * COLS + x] || !open[y * COLS + cx]))) continue;
      const d = dist[c] + (dx && dy ? Math.SQRT2 : 1);
      if (d >= dist[n]) continue;
      dist[n] = d;
      from[n] = c;
      queue.push(n);
    }
  }
  return { dist, from };
}

// Whether a shell would fly straight from `a` to `b` without touching a wall.
export function clearLine(a, b, radius = BULLET_RADIUS) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.ceil(length / 8);
  for (let i = 1; i < steps; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps };
    if (WALLS.some((w) => p.x > w.x - radius && p.x < w.x + w.w + radius && p.y > w.y - radius && p.y < w.y + w.h + radius)) return false;
  }
  return true;
}

// Follows a shell fired from `tank` at `angle`. Returns 'enemy' if it would
// hit `target` (with `slack` pixels to spare), 'self' if it would come back
// into the tank that fired it, or null.
export function tryShot(tank, angle, target, slack = 0) {
  const b = {
    x: tank.x + Math.cos(angle) * BARREL_LENGTH,
    y: tank.y + Math.sin(angle) * BARREL_LENGTH,
    vx: Math.cos(angle) * BULLET_SPEED,
    vy: Math.sin(angle) * BULLET_SPEED,
    bounces: 0,
  };
  if (circleHitsAnyWall(b, BULLET_RADIUS)) return null;
  for (let t = 0; t < SHOT_TIME; t += SHOT_STEP) {
    if (!stepBullet(b, SHOT_STEP)) return null;
    if (circleHitsCircle(b, BULLET_RADIUS, target, TANK_RADIUS + slack)) return 'enemy';
    if (b.bounces > 0 && circleHitsCircle(b, BULLET_RADIUS, tank, TANK_RADIUS + 4)) return 'self';
  }
  return null;
}

// A bot for the given level. `decide(game, seat, now)` is to be called
// often while the round is being played; it says when to think again, and
// returns { input, fire } for the bot's seat, or null when there is nothing
// new to do.
export function createBrain(level) {
  const i = level - 1;
  let nextThinkAt = 0;
  let aimOffset = 0;
  let lastEnemy = null; // { x, y, at }, to tell how fast the enemy moves
  let plan = null; // { goal, path } toward the spot it is making for
  let plannedAt = -Infinity;
  let ricochet = null; // the angle of a shot off a wall it found, or null
  let sweep = null; // { k, found, at }: how far it is in trying the angles
  const dodging = new Map(); // shell id -> whether it dodges that one
  let lastShotAt = -Infinity;

  // The cell to make for: low levels just drive at the enemy; the others
  // look for the nearest cell with a clear shot at a comfortable range.
  function choosePlan(me, enemy) {
    const { dist, from } = distances(cellOf(me));
    let goal = cellOf(enemy);
    if (level >= TACTICS_FROM) {
      let best = Infinity;
      const open = freeCells();
      for (let c = 0; c < open.length; c++) {
        if (!open[c] || dist[c] === Infinity) continue;
        const p = centreOf(c);
        const range = Math.hypot(p.x - enemy.x, p.y - enemy.y);
        const off = range < NEAR ? NEAR - range : range > FAR ? range - FAR : 0;
        const cost = dist[c] * CELL + off * 3;
        if (cost >= best || !clearLine(p, enemy, BULLET_RADIUS + 2)) continue;
        best = cost;
        goal = c;
      }
    }
    // Walked back from the goal to where the tank is.
    const path = [];
    for (let c = goal; c !== -1 && c !== cellOf(me); c = from[c]) path.unshift(c);
    return { goal, path };
  }

  // Which way to drive along the plan: toward the furthest of the next few
  // cells that can be reached in a straight line.
  function steer(me) {
    if (!plan || !plan.path.length) return null;
    const here = cellOf(me);
    const at = plan.path.indexOf(here);
    if (at !== -1) plan.path.splice(0, at + 1);
    let target = null;
    for (const c of plan.path.slice(0, 6)) {
      const p = centreOf(c);
      if (!clearLine(me, p, TANK_RADIUS)) break;
      target = p;
    }
    target ??= plan.path.length ? centreOf(plan.path[0]) : null;
    if (!target || Math.hypot(target.x - me.x, target.y - me.y) < 4) return null;
    return Math.atan2(target.y - me.y, target.x - me.x);
  }

  // The way out of the path of the first shell heading for the tank that it
  // chooses to dodge, or null.
  function dodge(game, me) {
    for (const shell of game.bullets) {
      if (!dodging.has(shell.id)) dodging.set(shell.id, Math.random() < DODGE[i]);
      if (!dodging.get(shell.id)) continue;
      const b = { ...shell };
      for (let t = 0; t < DODGE_LOOKAHEAD; t += 0.05) {
        if (!stepBullet(b, 0.05)) break;
        if (b.owner === game.you && b.bounces === 0) continue;
        if (!circleHitsCircle(b, BULLET_RADIUS, me, TANK_RADIUS + 10)) continue;
        // Across the shell's path, to whichever side the tank already is.
        const across = Math.atan2(b.vy, b.vx) + Math.PI / 2;
        const side = (me.x - b.x) * Math.cos(across) + (me.y - b.y) * Math.sin(across) >= 0 ? 0 : Math.PI;
        for (const angle of [across + side, across + side + Math.PI]) {
          const probe = { x: me.x + Math.cos(angle) * TANK_SPEED * 0.3, y: me.y + Math.sin(angle) * TANK_SPEED * 0.3 };
          if (!circleHitsAnyWall(probe, TANK_RADIUS)) return angle;
        }
      }
    }
    // Forget shells that are gone.
    if (dodging.size > 50) for (const id of dodging.keys()) if (!game.bullets.some((b) => b.id === id)) dodging.delete(id);
    return null;
  }

  // Where the turret should point: at where the enemy will be when a shell
  // gets there if the line is clear, or else a ricochet if one was found.
  function aimAt(me, enemy, velocity, now) {
    let target = enemy;
    if (level >= LEADS_FROM) {
      for (let k = 0; k < 2; k++) {
        const t = Math.hypot(target.x - me.x, target.y - me.y) / BULLET_SPEED;
        target = { x: enemy.x + velocity.x * t, y: enemy.y + velocity.y * t };
      }
    }
    if (clearLine(me, target)) return { angle: Math.atan2(target.y - me.y, target.x - me.x), clear: true };
    if (level < RICOCHETS_FROM) return { angle: Math.atan2(enemy.y - me.y, enemy.x - me.x), clear: false };
    // Trying every angle takes a while, so it is spread over a few turns of
    // thinking, and the last sweep's answer stands until the next is done.
    const done = () => sweep.k === RICOCHET_ANGLES;
    if (!sweep || (done() && now - sweep.at > 400)) sweep = { k: 0, found: null };
    if (!done()) {
      for (let n = 0; n < SWEEP_PART && !done(); n++) {
        const angle = -Math.PI + (2 * Math.PI * sweep.k++) / RICOCHET_ANGLES;
        if (tryShot(me, angle, enemy) !== 'enemy') continue;
        sweep.found = angle;
        sweep.k = RICOCHET_ANGLES;
      }
      if (done()) {
        sweep.at = now;
        ricochet = sweep.found;
      }
    }
    if (ricochet !== null) return { angle: ricochet, clear: true };
    return { angle: Math.atan2(enemy.y - me.y, enemy.x - me.x), clear: false };
  }

  return {
    decide(game, seat, now) {
      if (now < nextThinkAt) return null;
      nextThinkAt = now + THINK_MS[i] * (0.8 + Math.random() * 0.4);
      const me = game.tanks[seat];
      const enemy = game.tanks[1 - seat];
      if (!me.hp || !enemy.hp) return null;

      const velocity = { x: 0, y: 0 };
      if (lastEnemy && now > lastEnemy.at) {
        const dt = (now - lastEnemy.at) / 1000;
        velocity.x = (enemy.x - lastEnemy.x) / dt;
        velocity.y = (enemy.y - lastEnemy.y) / dt;
        const speed = Math.hypot(velocity.x, velocity.y);
        if (speed > TANK_SPEED) {
          velocity.x *= TANK_SPEED / speed;
          velocity.y *= TANK_SPEED / speed;
        }
      }
      lastEnemy = { x: enemy.x, y: enemy.y, at: now };

      if (now - plannedAt > 600 || !plan?.path.length) {
        plan = choosePlan(me, enemy);
        plannedAt = now;
        aimOffset = (Math.random() * 2 - 1) * AIM_ERROR[i];
      }
      const away = dodge({ ...game, you: seat }, me);
      const heading = away ?? steer(me);

      const aim = aimAt(me, enemy, velocity, now);
      const angle = wrapAngle(aim.angle + aimOffset);
      const ready = now - lastShotAt >= FIRE_COOLDOWN * 1000;
      const lined = Math.abs(wrapAngle(me.turret - angle)) < AIM_TOLERANCE;
      // Never a shot that would come back into itself.
      const fire = ready && lined && aim.clear && (level < 2 || tryShot(me, me.turret, enemy, 20) !== 'self');
      if (fire) lastShotAt = now;
      return { input: { ...driveToward(heading), aim: angle }, fire };
    },
  };
}

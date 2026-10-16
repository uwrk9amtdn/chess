// One tank duel in progress: the authoritative simulation, the rounds and
// the result. Unlike the board games it runs on a clock of its own, stepping
// the battle TICK_RATE times a second and sending a snapshot after each step
// while the tanks are fighting.

import { randomUUID } from 'node:crypto';
import {
  BARREL_LENGTH, BULLET_RADIUS, BULLET_SPEED, COUNTDOWN_MS, FIRE_COOLDOWN, MAX_HP,
  ROUND_LIMIT_MS, ROUND_OVER_MS, TANK_RADIUS, TICK_RATE, TURRET_TURN_SPEED,
} from '../shared/constants.js';
import { SPAWNS } from '../shared/map.js';
import {
  NO_INPUT, circleHitsAnyWall, circleHitsCircle, moveTank, rotateTowards, stepBullet,
} from '../shared/physics.js';

const TICK_MS = 1000 / TICK_RATE;
// A late tick is caught up in steps no longer than one tick, and a very late
// one (the process was busy) only in part, rather than all at once.
const MAX_CATCH_UP_MS = 250;

// Positions and angles are sent to a tenth of a pixel and a thousandth of a
// radian, which keeps the snapshots short.
const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;

export class TanksMatch {
  // `players` holds one name per seat and `options` is what validateOptions
  // returned. `bots` says, per seat, which level of bot plays it (or null);
  // its inputs arrive like anyone's, from the browser of the player it faces.
  // `onChange(match)` fires after anything the players should see.
  constructor({ players, options, bots, onChange }) {
    this.id = randomUUID();
    this.players = players;
    this.options = options;
    this.bots = bots ?? players.map(() => null);
    this.onChange = onChange;
    this.score = players.map(() => 0);
    // How each finished round went: { winner, reason }, `winner` null when
    // neither tank came out of it ahead.
    this.rounds = [];
    this.inputs = players.map(() => ({ ...NO_INPUT }));
    this.connected = players.map(() => true);
    this.spectators = 0;
    this.over = null;
    // Seconds of battle so far, which the firing cooldown is measured in, so
    // that a pause does not count.
    this.time = 0;
    this.nextBulletId = 0;
    this.startRound();
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  startRound() {
    this.tanks = SPAWNS.map((s) => ({ x: s.x, y: s.y, hull: s.angle, turret: s.angle, hp: MAX_HP }));
    for (const [seat, input] of this.inputs.entries()) input.aim = SPAWNS[seat].angle;
    this.bullets = [];
    this.lastFireAt = this.players.map(() => -Infinity);
    this.roundMsLeft = ROUND_LIMIT_MS;
    this.phase = 'countdown';
    this.phaseMsLeft = COUNTDOWN_MS;
  }

  tick() {
    const now = Date.now();
    const elapsed = Math.min(MAX_CATCH_UP_MS, now - this.lastTickAt);
    this.lastTickAt = now;
    this.advance(elapsed);
  }

  // Everything that happens in `ms` of match time. Nothing does while a
  // player is away.
  advance(ms) {
    if (this.over || this.connected.some((c) => !c)) return;
    if (this.phase === 'countdown') {
      this.phaseMsLeft -= ms;
      if (this.phaseMsLeft > 0) return;
      this.phase = 'playing';
      this.phaseMsLeft = 0;
    } else if (this.phase === 'playing') {
      for (let left = ms; left > 0 && this.phase === 'playing'; left -= TICK_MS) this.step(Math.min(left, TICK_MS) / 1000);
    } else {
      this.phaseMsLeft -= ms;
      if (this.phaseMsLeft > 0) return;
      this.startRound();
    }
    // The last round's end has been told of already, by finish().
    if (!this.over) this.onChange(this);
  }

  // One step of the battle, `dt` seconds long.
  step(dt) {
    this.time += dt;
    this.roundMsLeft -= dt * 1000;
    this.tanks.forEach((tank, seat) => {
      if (!tank.hp) return;
      const input = this.inputs[seat];
      const others = this.tanks.filter((other) => other !== tank && other.hp);
      const pos = { x: tank.x, y: tank.y };
      const heading = moveTank(pos, input, dt, others);
      tank.x = pos.x;
      tank.y = pos.y;
      if (heading !== null) tank.hull = heading;
      tank.turret = rotateTowards(tank.turret, input.aim, TURRET_TURN_SPEED * dt);
    });

    this.bullets = this.bullets.filter((bullet) => {
      if (!stepBullet(bullet, dt)) return false;
      const hit = this.tanks.findIndex((tank, seat) => tank.hp &&
        // A shell can only hit its own tank once it has ricocheted.
        (seat !== bullet.owner || bullet.bounces > 0) &&
        circleHitsCircle(bullet, BULLET_RADIUS, tank, TANK_RADIUS));
      if (hit === -1) return true;
      this.tanks[hit].hp--;
      return false;
    });

    const alive = this.tanks.flatMap((tank, seat) => (tank.hp ? [seat] : []));
    if (alive.length < 2) this.endRound(alive.length ? alive[0] : null, alive.length ? 'destroyed' : 'both');
    else if (this.roundMsLeft <= 0) {
      // Out of time: the tank with more armour left takes the round.
      const [a, b] = this.tanks.map((t) => t.hp);
      this.endRound(a === b ? null : a > b ? 0 : 1, 'time');
    }
  }

  endRound(winner, reason) {
    this.rounds.push({ winner, reason });
    if (winner !== null) this.score[winner]++;
    this.bullets = [];
    this.phase = 'roundOver';
    this.phaseMsLeft = ROUND_OVER_MS;
    // The best of N is won with more than half of them. Rounds that nobody
    // won do not count, but a match does not go on for more than twice N.
    const needed = (this.options.rounds + 1) / 2;
    const leader = this.score.findIndex((s) => s >= needed);
    if (leader !== -1) this.finish('rounds', leader);
    else if (this.rounds.length >= 2 * this.options.rounds) {
      const [a, b] = this.score;
      this.finish('limit', a === b ? null : a > b ? 0 : 1);
    }
  }

  finish(reason, winner) {
    if (this.over) return;
    clearInterval(this.timer);
    // With the rounds won, for the list of finished matches.
    this.over = { reason, winner, score: this.score.slice() };
    this.onChange(this);
  }

  // The lobby forwards every message from a player here. Returns an error
  // message for the player, or null. Inputs and shots come many times a
  // second and are never answered, even when they are of no use.
  handle(seat, action) {
    switch (action.action) {
      case 'input': this.setInput(seat, action); return null;
      case 'fire': this.fire(seat); return null;
      case 'resign': this.finish('resign', 1 - seat); return null;
      default: return 'Unknown action';
    }
  }

  // Which way the player wants to drive, and where the turret should point.
  // The tank does it in the steps that follow.
  setInput(seat, { left, right, up, down, aim }) {
    if (!Number.isFinite(aim)) return;
    this.inputs[seat] = { left: left === true, right: right === true, up: up === true, down: down === true, aim };
  }

  fire(seat) {
    if (this.over || this.phase !== 'playing' || this.connected.some((c) => !c)) return;
    const tank = this.tanks[seat];
    if (!tank.hp || this.time - this.lastFireAt[seat] < FIRE_COOLDOWN) return;
    const muzzle = {
      x: tank.x + Math.cos(tank.turret) * BARREL_LENGTH,
      y: tank.y + Math.sin(tank.turret) * BARREL_LENGTH,
    };
    // A barrel pushed into a wall must not shoot out the other side.
    if (circleHitsAnyWall(muzzle, BULLET_RADIUS)) return;
    this.lastFireAt[seat] = this.time;
    this.bullets.push({
      id: this.nextBulletId++,
      owner: seat,
      ...muzzle,
      vx: Math.cos(tank.turret) * BULLET_SPEED,
      vy: Math.sin(tank.turret) * BULLET_SPEED,
      bounces: 0,
    });
  }

  // The player left and did not come back in time.
  abandon(seat) {
    this.finish('abandoned', 1 - seat);
  }

  // The battle stops while a player is away, and starts again with a
  // countdown, so nobody is shot at while they cannot answer.
  setConnected(seat, connected) {
    this.connected[seat] = connected;
    if (!connected && this.phase === 'playing') {
      this.phase = 'countdown';
      this.phaseMsLeft = COUNTDOWN_MS;
    }
    this.onChange(this);
  }

  setSpectators(count) {
    this.spectators = count;
    this.onChange(this);
  }

  // Everything the player in `seat` needs to draw the battle right now. A
  // spectator (`seat` is null) sees the same; nothing is hidden.
  snapshot(seat) {
    return {
      id: this.id,
      players: this.players,
      bots: this.bots,
      you: seat,
      options: this.options,
      phase: this.phase,
      phaseMsLeft: Math.max(0, Math.round(this.phaseMsLeft)),
      roundMsLeft: Math.max(0, Math.round(this.roundMsLeft)),
      paused: this.connected.some((c) => !c),
      score: this.score,
      // The rounds played, which the platform reads as moves: a match in
      // which no round was finished is not kept.
      moves: this.rounds,
      tanks: this.tanks.map((t) => ({ x: round1(t.x), y: round1(t.y), hull: round3(t.hull), turret: round3(t.turret), hp: t.hp })),
      bullets: this.bullets.map((b) => ({
        id: b.id, owner: b.owner, x: round1(b.x), y: round1(b.y), vx: round1(b.vx), vy: round1(b.vy), bounces: b.bounces,
      })),
      connected: this.connected,
      spectators: this.spectators,
      over: this.over,
    };
  }
}

// Tanks on the server: the invitation options, a match stepped by hand, the
// bot, and matches through the real lobby.

import test from 'node:test';
import assert from 'node:assert/strict';
import tanks from '../server/index.js';
import { COUNTDOWN_MS, FIRE_COOLDOWN, MAX_HP, ROUND_OVER_MS } from '../shared/constants.js';
import { stepBullet } from '../shared/physics.js';
import { createBrain, tryShot } from '../shared/bot.js';
import { startServer } from '../../../server/index.js';
import { connect } from '../../../test/helpers.js';

test('invitation options and bots', () => {
  assert.deepEqual(tanks.validateOptions({ rounds: 3, junk: 1 }), { options: { rounds: 3 } });
  for (const bad of [{}, { rounds: 2 }, { rounds: '3' }, { rounds: 7 }]) assert.ok(tanks.validateOptions(bad).error, JSON.stringify(bad));
  assert.deepEqual(tanks.validateBot({ level: 8 }), { bot: { level: 8 }, name: 'Computer level 8' });
  for (const bad of [{}, { level: 0 }, { level: 9 }, { level: 1.5 }]) assert.ok(tanks.validateBot(bad).error);
});

// A match whose clock is stepped by the test rather than by a timer.
function newMatch(rounds = 3) {
  const changes = [];
  const match = tanks.createMatch({ players: ['green', 'blue'], options: { rounds }, onChange: (m) => changes.push(m.snapshot(0)) });
  clearInterval(match.timer);
  return { match, changes };
}

// Lines the tanks up across open ground, seat 0 on the left facing seat 1.
function faceOff(match) {
  Object.assign(match.tanks[0], { x: 480, y: 560, turret: 0 });
  Object.assign(match.tanks[1], { x: 800, y: 560, turret: Math.PI });
  match.handle(0, { action: 'input', aim: 0 });
  match.handle(1, { action: 'input', aim: Math.PI });
}

// Seat 0 shoots seat 1 out of the round.
function winRound(match) {
  match.advance(COUNTDOWN_MS);
  assert.equal(match.phase, 'playing');
  faceOff(match);
  for (let shot = 0; shot < MAX_HP; shot++) {
    match.handle(0, { action: 'fire' });
    match.advance(FIRE_COOLDOWN * 1000 + 50);
    match.advance(500);
  }
}

test('a round: countdown, shots, the score', () => {
  const { match, changes } = newMatch();
  assert.equal(match.phase, 'countdown');
  // Nothing fires before the round starts.
  match.handle(0, { action: 'fire' });
  assert.equal(match.bullets.length, 0);
  assert.match(match.handle(0, { action: 'dance' }), /Unknown/);
  match.advance(COUNTDOWN_MS - 1);
  assert.equal(match.phase, 'countdown');
  // The countdown sends nothing until it is over.
  assert.equal(changes.length, 0);

  match.advance(1);
  faceOff(match);
  match.handle(0, { action: 'fire' });
  match.handle(0, { action: 'fire' });
  assert.equal(match.bullets.length, 1, 'the cooldown holds the second shot');
  const snap = match.snapshot(null);
  assert.equal(snap.you, null);
  assert.deepEqual(snap.bullets[0], { id: 0, owner: 0, x: 508, y: 560, vx: 420, vy: 0, bounces: 0 });
  match.advance(1000);
  assert.equal(match.tanks[1].hp, MAX_HP - 1);
  assert.deepEqual(tanks.preview(match.snapshot(null)), { score: [0, 0], hp: [3, 2] });

  for (let shot = 1; shot < MAX_HP; shot++) {
    match.handle(0, { action: 'fire' });
    match.advance(1000);
  }
  assert.equal(match.phase, 'roundOver');
  assert.deepEqual(match.rounds, [{ winner: 0, reason: 'destroyed' }]);
  assert.deepEqual(changes.at(-1).score, [1, 0]);
  assert.deepEqual(changes.at(-1).moves, match.rounds);
  match.advance(ROUND_OVER_MS);
  assert.equal(match.phase, 'countdown');
  assert.deepEqual(match.tanks.map((t) => t.hp), [MAX_HP, MAX_HP]);
  winRound(match);
  assert.deepEqual(match.over, { reason: 'rounds', winner: 0, score: [2, 0] });
  assert.deepEqual(changes.at(-1).over, match.over);
});

test('moving and aiming', () => {
  const { match } = newMatch();
  match.advance(COUNTDOWN_MS);
  const { x, y } = match.tanks[0];
  match.handle(0, { action: 'input', right: true, down: 'yes', aim: 1 });
  assert.deepEqual(match.inputs[0], { left: false, right: true, up: false, down: false, aim: 1 });
  match.handle(0, { action: 'input', aim: NaN });
  assert.equal(match.inputs[0].aim, 1, 'a bad input is ignored');
  match.advance(500);
  assert.ok(Math.abs(match.tanks[0].x - (x + 80)) < 1);
  assert.equal(match.tanks[0].y, y);
  assert.equal(match.tanks[0].hull, 0);
  assert.equal(match.tanks[0].turret, 1);
});

test('a player away pauses the battle', () => {
  const { match } = newMatch();
  match.advance(COUNTDOWN_MS);
  faceOff(match);
  match.handle(0, { action: 'fire' });
  match.setConnected(1, false);
  assert.equal(match.snapshot(0).paused, true);
  assert.equal(match.phase, 'countdown');
  match.advance(10_000);
  assert.equal(match.tanks[1].hp, MAX_HP, 'the shell waits too');
  match.handle(0, { action: 'fire' });
  assert.equal(match.bullets.length, 1);
  match.setConnected(1, true);
  match.advance(COUNTDOWN_MS);
  assert.equal(match.phase, 'playing');
  match.advance(1000);
  assert.equal(match.tanks[1].hp, MAX_HP - 1);
  match.abandon(1);
  assert.deepEqual(match.over, { reason: 'abandoned', winner: 0, score: [0, 0] });
});

test('out of time, resigning, and the round limit', () => {
  const { match } = newMatch(1);
  match.advance(COUNTDOWN_MS);
  match.tanks[0].hp = 1;
  match.roundMsLeft = 40;
  match.advance(50);
  assert.deepEqual(match.rounds, [{ winner: 1, reason: 'time' }]);
  assert.deepEqual(match.over, { reason: 'rounds', winner: 1, score: [0, 1] });

  const even = newMatch(1).match;
  for (let round = 0; round < 2; round++) {
    even.advance(COUNTDOWN_MS);
    even.roundMsLeft = 10;
    even.advance(50);
    even.advance(ROUND_OVER_MS);
  }
  assert.deepEqual(even.rounds.map((r) => r.winner), [null, null]);
  assert.deepEqual(even.over, { reason: 'limit', winner: null, score: [0, 0] });

  const quitter = newMatch().match;
  quitter.handle(0, { action: 'resign' });
  assert.deepEqual(quitter.over, { reason: 'resign', winner: 1, score: [0, 0] });
});

test('shells bounce once, and can come back', () => {
  // Straight at the left border: back once, and gone at the right one.
  const b = { x: 100, y: 560, vx: -420, vy: 0, bounces: 0 };
  let steps = 0;
  while (stepBullet(b, 0.05)) steps++;
  assert.equal(b.bounces, 2);
  assert.ok(steps > 50, `flew ${steps} steps`);
  // Fired at a wall right in front, the shell comes back into its tank.
  assert.equal(tryShot({ x: 640, y: 290 }, Math.PI / 2, { x: 100, y: 100 }), 'self');
});

test('the bot drives, aims and hits', () => {
  const { match } = newMatch(1);
  match.bots = [null, { level: 8 }];
  match.advance(COUNTDOWN_MS);
  faceOff(match);
  const brain = createBrain(8);
  let now = 0;
  while (!match.over && now < 20_000) {
    const decision = brain.decide(match.snapshot(1), 1, now);
    if (decision) {
      assert.equal(typeof decision.input.left, 'boolean');
      assert.ok(Number.isFinite(decision.input.aim));
      match.handle(1, { action: 'input', ...decision.input });
      if (decision.fire) match.handle(1, { action: 'fire' });
    }
    match.advance(50);
    now += 50;
  }
  assert.deepEqual(match.over, { reason: 'rounds', winner: 1, score: [0, 1] });
});

async function joined(server, ...names) {
  const clients = names.map(() => connect(server.port));
  await Promise.all(clients.map((c) => c.opened));
  clients.forEach((c, i) => c.send({ type: 'join', name: names[i] }));
  await Promise.all(clients.map((c) => c.next('joined')));
  return clients;
}

test('a match through the lobby', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const [alice, bob] = await joined(server, 'alice', 'bob');
  await alice.next('users', (m) => m.users.length === 2);
  alice.send({ type: 'invite', to: 'bob', game: 'tanks', options: { rounds: 3 } });
  const invite = await bob.next('invite');
  bob.send({ type: 'accept', id: invite.id });
  const [first] = await Promise.all([alice.next('match'), bob.next('match')]);
  assert.equal(first.snapshot.phase, 'countdown');
  assert.equal(first.snapshot.tanks.length, 2);
  alice.send({ type: 'action', action: 'input', up: true, aim: 0 });
  alice.send({ type: 'action', action: 'resign' });
  const last = await alice.next('match', (m) => m.snapshot.over);
  assert.equal(last.snapshot.over.reason, 'resign');
  assert.equal((await fetch(`http://localhost:${server.port}/games/tanks/server/match.js`)).status, 404);
  assert.equal((await fetch(`http://localhost:${server.port}/games/tanks/shared/bot.js`)).status, 200);
});

test('a match against the computer through the lobby', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const [carol] = await joined(server, 'carol');
  carol.send({ type: 'bot', game: 'tanks', options: { rounds: 1 }, bot: { level: 2 }, seat: 0 });
  const { snapshot } = await carol.next('match');
  assert.deepEqual([snapshot.you, snapshot.bots, snapshot.players[1]], [0, [null, { level: 2 }], 'Computer level 2']);
  // The countdown ends, and the bot's seat drives as told.
  await new Promise((resolve) => setTimeout(resolve, COUNTDOWN_MS));
  await carol.next('match', (m) => m.snapshot.phase === 'playing');
  carol.send({ type: 'action', action: 'input', left: true, aim: 0, bot: true });
  const x = snapshot.tanks[1].x;
  const moved = await carol.next('match', (m) => m.snapshot.tanks[1].x < x - 10);
  assert.equal(moved.snapshot.tanks[0].x, snapshot.tanks[0].x, 'the player did not move');
  carol.send({ type: 'action', action: 'resign' });
  assert.equal((await carol.next('match', (m) => m.snapshot.over)).snapshot.over.winner, 1);
});

// Mill on the server: the invitation options, a match on its own, and one
// game through the real lobby.

import test from 'node:test';
import assert from 'node:assert/strict';
import mill from '../server/index.js';
import { VARIANTS, createGame, applyMove, boardKey } from '../shared/rules.js';
import { startServer } from '../../../server/index.js';
import { connect } from '../../../test/helpers.js';

const OPTIONS = { variant: 'nine', minutes: 5, increment: 2 };
const { nine } = VARIANTS;
const at = (name) => nine.points.findIndex((p) => p.name === name);

test('invitation options and bots', () => {
  assert.deepEqual(mill.validateOptions({ minutes: 5, increment: 2, junk: 1 }).options, OPTIONS);
  assert.equal(mill.validateOptions({ ...OPTIONS, variant: 'twelve' }).options.variant, 'twelve');
  for (const bad of [{}, { ...OPTIONS, variant: 'three' }, { ...OPTIONS, variant: 'constructor' }, { ...OPTIONS, minutes: 0 },
    { ...OPTIONS, increment: 1.5 }, { ...OPTIONS, minutes: '5' }]) {
    assert.ok(mill.validateOptions(bad).error, JSON.stringify(bad));
  }
  assert.deepEqual(mill.validateBot({ level: 4, junk: 1 }), { bot: { level: 4 }, name: 'Computer level 4' });
  for (const bad of [{}, { level: 0 }, { level: 9 }, { level: 2.5 }]) assert.ok(mill.validateBot(bad).error);
});

function newMatch(options) {
  const changes = [];
  const match = mill.createMatch({
    players: ['white', 'black'],
    options: { ...OPTIONS, ...options },
    onChange: (m) => changes.push(m.snapshot(0)),
  });
  return { match, changes };
}

// Puts pieces down by name, each by whoever is to move.
function place(match, names) {
  for (const name of names) assert.equal(match.handle(match.state.turn, { action: 'move', to: at(name) }), null, name);
}

test('moves, a mill and the snapshot', () => {
  const { match, changes } = newMatch();
  assert.match(match.handle(1, { action: 'move', to: at('d2') }), /turn/);
  assert.match(match.handle(0, { action: 'move', to: 99 }), /free point/);
  assert.match(match.handle(0, { action: 'dance' }), /Unknown/);
  place(match, ['a1', 'b4', 'd1', 'f4']);
  // g1 closes a mill: it must say which piece goes.
  assert.match(match.handle(0, { action: 'move', to: at('g1') }), /Take one/);
  assert.equal(match.handle(0, { action: 'move', to: at('g1'), remove: at('b4') }), null);
  const snap = changes.at(-1);
  assert.deepEqual(snap.moves, ['a1', 'b4', 'd1', 'f4', 'g1xb4']);
  assert.deepEqual(snap.played.at(-1), { to: at('g1'), remove: at('b4') });
  assert.deepEqual([snap.turn, snap.inHand, snap.onBoard, snap.running], [1, [6, 7], [3, 1], 1]);
  const replayed = snap.played.reduce((s, m) => applyMove(s, nine, m), createGame(nine));
  assert.equal(boardKey(replayed.board), snap.board);
  assert.ok(snap.clocks[0] > 305_000 && snap.clocks[0] <= 306_000);
  assert.deepEqual(mill.preview(match.snapshot(null)), { variant: 'nine', board: snap.board, lastMove: snap.lastMove });
  assert.equal(match.snapshot(null).you, null);
  match.handle(1, { action: 'resign' });
  assert.deepEqual(match.over, { reason: 'resign', winner: 0 });
});

test('draw offers and takebacks', () => {
  const { match, changes } = newMatch();
  place(match, ['a1', 'b4']);
  match.handle(0, { action: 'offerDraw' });
  match.handle(0, { action: 'acceptDraw' });
  assert.equal(match.drawOffer, 0);
  match.handle(1, { action: 'declineDraw' });
  assert.equal(match.drawOffer, null);

  match.handle(1, { action: 'offerTakeback' });
  match.handle(0, { action: 'acceptTakeback' });
  let snap = changes.at(-1);
  assert.deepEqual([snap.moves, snap.turn, snap.takebacks, snap.lastMove, snap.inHand], [['a1'], 1, 1, { to: at('a1') }, [8, 9]]);

  match.handle(1, { action: 'offerDraw' });
  match.handle(0, { action: 'acceptDraw' });
  snap = changes.at(-1);
  assert.deepEqual(snap.over, { reason: 'agreement', winner: null });
});

test('a mill in Six Men\'s Morris', () => {
  const { match } = newMatch({ variant: 'six' });
  const six = VARIANTS.six;
  const p = (name) => six.points.findIndex((q) => q.name === name);
  // White closes a1-c1-e1 and takes b2.
  const turns = [
    [{ to: p('a1') }, { to: p('b2') }], [{ to: p('c1') }, { to: p('d2') }],
    [{ to: p('e1'), remove: p('b2') }, { to: p('b4') }],
  ];
  for (const [white, black] of turns) {
    assert.equal(match.handle(0, { action: 'move', ...white }), null);
    assert.equal(match.handle(1, { action: 'move', ...black }), null);
  }
  assert.equal(match.over, null);
  match.handle(1, { action: 'resign' });
  assert.deepEqual(match.over, { reason: 'resign', winner: 0 });
});

test('time and leaving', async () => {
  const slow = newMatch({ minutes: 0.002, increment: 0 }).match;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(slow.over, { reason: 'timeout', winner: 1 });
  const gone = newMatch().match;
  gone.abandon(1);
  assert.deepEqual(gone.over, { reason: 'abandoned', winner: 0 });
});

test('a game through the lobby', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  assert.ok((await alice.next('joined')).games.some((g) => g.id === 'mill'));
  await alice.next('users', (m) => m.users.length === 2);
  alice.send({ type: 'invite', to: 'bob', game: 'mill', options: OPTIONS });
  const invite = await bob.next('invite');
  bob.send({ type: 'accept', id: invite.id });
  const [first] = await Promise.all([alice.next('match'), bob.next('match')]);
  assert.equal(first.snapshot.board.length, 24);
  const white = first.snapshot.you === 0 ? alice : bob;
  white.send({ type: 'action', action: 'move', to: at('d2') });
  assert.deepEqual((await white.next('match', (m) => m.snapshot.moves.length === 1)).snapshot.moves, ['d2']);
  assert.equal((await fetch(`http://localhost:${server.port}/games/mill/server/match.js`)).status, 404);
});

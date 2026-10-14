// Gomoku on the server: the invitation options, a match on its own with and
// without Swap2, and one game through the real lobby.

import test from 'node:test';
import assert from 'node:assert/strict';
import gomoku from '../server/index.js';
import { createGame, applyMove, boardKey, BLACK, WHITE } from '../shared/rules.js';
import { startServer } from '../../../server/index.js';
import { connect } from '../../../test/helpers.js';

const OPTIONS = { variant: 'freestyle', size: 15, opening: 'none', minutes: 5, increment: 3 };
const at = (name) => 'ABCDEFGHIJKLMNO'.indexOf(name[0]) + (Number(name.slice(1)) - 1) * 15;

test('invitation options', () => {
  assert.deepEqual(gomoku.validateOptions({ minutes: 5, increment: 3, junk: 1 }).options, OPTIONS);
  assert.deepEqual(gomoku.validateOptions({ ...OPTIONS, variant: 'renju', opening: 'swap2' }).options,
    { ...OPTIONS, variant: 'renju', opening: 'swap2' });
  assert.equal(gomoku.validateOptions({ ...OPTIONS, size: 19 }).options.size, 19);
  for (const bad of [
    {}, { ...OPTIONS, variant: 'connect6' }, { ...OPTIONS, variant: 'constructor' }, { ...OPTIONS, size: 13 },
    { ...OPTIONS, variant: 'renju', size: 19 }, { ...OPTIONS, opening: 'swap' }, { ...OPTIONS, minutes: 0 },
    { ...OPTIONS, increment: 1.5 }, { ...OPTIONS, minutes: '5' },
  ]) {
    assert.ok(gomoku.validateOptions(bad).error, JSON.stringify(bad));
  }
  assert.deepEqual(gomoku.validateBot({ level: 4, junk: 1 }), { bot: { level: 4 }, name: 'Computer level 4' });
  for (const bad of [{}, { level: 0 }, { level: 9 }, { level: 2.5 }]) assert.ok(gomoku.validateBot(bad).error);
});

function newMatch(options) {
  const changes = [];
  const match = gomoku.createMatch({
    players: ['first', 'second'],
    options: { ...OPTIONS, ...options },
    onChange: (m) => changes.push(m.snapshot(0)),
  });
  return { match, changes };
}

// Plays stones by name, each by whoever is to act.
function playAll(match, names) {
  for (const name of names) assert.equal(match.handle(match.actor(), { action: 'move', point: at(name) }), null, name);
}

test('moves, five in a row and the snapshot', () => {
  const { match, changes } = newMatch();
  assert.match(match.handle(1, { action: 'move', point: at('H8') }), /turn/);
  assert.match(match.handle(0, { action: 'move', point: 225 }), /board/);
  assert.match(match.handle(0, { action: 'dance' }), /Unknown/);
  assert.match(match.handle(0, { action: 'choose', choice: 'white' }), /nothing to choose/);
  playAll(match, ['H8', 'H9', 'I8', 'I9', 'J8', 'J9', 'K8']);
  let snap = changes.at(-1);
  assert.deepEqual(snap.moves, ['H8', 'H9', 'I8', 'I9', 'J8', 'J9', 'K8']);
  assert.deepEqual([snap.turn, snap.actor, snap.running, snap.colours, snap.step], [WHITE, 1, 1, [BLACK, WHITE], null]);
  const replayed = snap.played.reduce((s, p) => applyMove(s, p, 'freestyle'), createGame(15));
  assert.equal(boardKey(replayed.board), snap.board);
  // Four moves by Black, each adding three seconds.
  assert.ok(snap.clocks[0] > 311_000 && snap.clocks[0] <= 312_000);
  assert.equal(match.snapshot(null).you, null);

  playAll(match, ['K9', 'G8']);
  snap = changes.at(-1);
  assert.deepEqual(match.over, { reason: 'five', winner: 0, colour: BLACK });
  assert.deepEqual(snap.line, ['G8', 'H8', 'I8', 'J8', 'K8'].map(at));
  assert.deepEqual(gomoku.preview(match.snapshot(null)), { size: 15, board: snap.board, lastMove: at('G8'), line: snap.line });
  assert.match(match.handle(1, { action: 'move', point: 0 }), /over/);
});

test('Renju refuses Black\'s forbidden moves; Standard does not count six', () => {
  const renju = newMatch({ variant: 'renju' }).match;
  playAll(renju, ['G8', 'A1', 'I8', 'A3', 'H7', 'A5', 'H9', 'A7']);
  assert.match(renju.handle(0, { action: 'move', point: at('H8') }), /double three/);
  renju.handle(0, { action: 'resign' });

  const standard = newMatch({ variant: 'standard' }).match;
  playAll(standard, ['C8', 'C1', 'D8', 'D1', 'E8', 'E1', 'G8', 'G1', 'H8', 'H1', 'F8']);
  assert.equal(standard.over, null);
  standard.handle(1, { action: 'resign' });
});

test('Swap2: the second player takes a colour', () => {
  const { match, changes } = newMatch({ opening: 'swap2' });
  assert.deepEqual([match.snapshot(0).colours, match.step, match.actor()], [[null, null], 'place3', 0]);
  playAll(match, ['H8', 'H9', 'I8']);
  assert.deepEqual([match.step, match.actor()], ['choose', 1]);
  assert.match(match.handle(1, { action: 'move', point: at('A1') }), /colour/);
  assert.match(match.handle(0, { action: 'choose', choice: 'black' }), /turn/);
  assert.match(match.handle(1, { action: 'choose', choice: 'red' }), /black or white/);
  // Taking White, the second player moves at once: White is to play.
  assert.equal(match.handle(1, { action: 'choose', choice: 'white' }), null);
  const snap = changes.at(-1);
  assert.deepEqual([snap.colours, snap.step, snap.actor, snap.openingPlies], [[BLACK, WHITE], null, 1, 3]);
  assert.deepEqual(snap.choices, [{ seat: 1, choice: 'white', stones: 3 }]);
  // The opening stones cannot be taken back.
  match.handle(0, { action: 'offerTakeback' });
  assert.equal(match.takebackOffer, null);
  match.handle(1, { action: 'resign' });
  assert.deepEqual(match.over, { reason: 'resign', winner: 0, colour: BLACK });
});

test('Swap2: two more stones, and the first player chooses', () => {
  const { match } = newMatch({ opening: 'swap2' });
  playAll(match, ['H8', 'H9', 'I8']);
  match.handle(1, { action: 'choose', choice: 'placeTwo' });
  assert.deepEqual([match.step, match.actor()], ['place2', 1]);
  playAll(match, ['I9', 'J10']);
  assert.deepEqual([match.step, match.actor()], ['choose2', 0]);
  assert.match(match.handle(0, { action: 'choose', choice: 'placeTwo' }), /black or white/);
  // The first player takes Black, so the second, now White, moves.
  match.handle(0, { action: 'choose', choice: 'black' });
  assert.deepEqual([match.colours, match.actor(), match.state.turn], [[BLACK, WHITE], 1, WHITE]);
  // Resigning before the colours are known names nobody's colour.
  const early = newMatch({ opening: 'swap2' }).match;
  early.handle(0, { action: 'resign' });
  assert.deepEqual(early.over, { reason: 'resign', winner: 1, colour: null });
  match.handle(0, { action: 'resign' });
});

test('takebacks', () => {
  const { match, changes } = newMatch();
  playAll(match, ['H8', 'H9']);
  match.handle(0, { action: 'offerTakeback' });
  match.handle(1, { action: 'acceptTakeback' });
  const snap = changes.at(-1);
  assert.deepEqual([snap.moves, snap.turn, snap.takebacks, snap.lastMove], [[], BLACK, 1, null]);
  match.handle(0, { action: 'resign' });
});

test('a full board is a draw; time and leaving lose', async () => {
  const { match } = newMatch();
  match.state = { ...match.state, count: 224 };
  match.handle(0, { action: 'move', point: at('H8') });
  assert.deepEqual(match.over, { reason: 'full', winner: null, colour: null });

  const slow = newMatch({ minutes: 0.002, increment: 0 }).match;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(slow.over, { reason: 'timeout', winner: 1, colour: WHITE });

  const gone = newMatch().match;
  gone.abandon(0);
  assert.deepEqual(gone.over, { reason: 'abandoned', winner: 1, colour: WHITE });
});

test('a Renju game through the lobby', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  assert.ok((await alice.next('joined')).games.some((g) => g.id === 'gomoku'));
  await alice.next('users', (m) => m.users.length === 2);

  alice.send({ type: 'invite', to: 'bob', game: 'gomoku', options: { ...OPTIONS, variant: 'renju', size: 19 } });
  await alice.next('error');
  alice.send({ type: 'invite', to: 'bob', game: 'gomoku', options: { ...OPTIONS, variant: 'renju' } });
  const invite = await bob.next('invite');
  bob.send({ type: 'accept', id: invite.id });
  const [first] = await Promise.all([alice.next('match'), bob.next('match')]);
  assert.equal(first.game, 'gomoku');
  assert.equal(first.snapshot.board.length, 225);
  const black = first.snapshot.you === 0 ? alice : bob;
  black.send({ type: 'action', action: 'move', point: at('H8') });
  assert.deepEqual((await black.next('match', (m) => m.snapshot.moves.length === 1)).snapshot.moves, ['H8']);

  const get = async (path) => (await fetch(`http://localhost:${server.port}${path}`)).status;
  assert.equal(await get('/games/gomoku/shared/rules.js'), 200);
  assert.equal(await get('/games/gomoku/server/match.js'), 404);
  assert.equal(await get('/js/kit/stoneboard.js'), 200);
});

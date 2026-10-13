// Chess on the server: the invitation options, a match on its own, and one
// game through the real lobby.

import test from 'node:test';
import assert from 'node:assert/strict';
import chess from '../server/index.js';
import { createGame, applyMove, serialize } from '../shared/engine.js';
import { variants } from '../shared/variants.js';
import { startServer } from '../../../server/index.js';
import { connect } from '../../../test/helpers.js';

test('invitation options', () => {
  assert.deepEqual(chess.validateOptions({ minutes: 3, increment: 1 }).options,
    { variant: 'standard', minutes: 3, increment: 1 });
  assert.deepEqual(chess.validateOptions({ minutes: 5, increment: 0, variant: 'double', junk: 1 }).options,
    { variant: 'double', minutes: 5, increment: 0 });
  for (const bad of [
    {}, { minutes: 500, increment: 1 }, { minutes: 0.5, increment: 1 }, { minutes: 3, increment: 1.5 },
    { minutes: 3, increment: 99 }, { minutes: '3', increment: 1 }, { minutes: 3, increment: 1, variant: 'nope' },
    { minutes: 3, increment: 1, variant: 'constructor' },
  ]) {
    assert.ok(chess.validateOptions(bad).error, JSON.stringify(bad));
  }
  assert.ok(chess.validateOptions({ minutes: 0.5, increment: 0 }, { minMinutes: 0.1 }).options);
});

test('bots', () => {
  const options = { variant: 'standard', minutes: 3, increment: 1 };
  assert.deepEqual(chess.validateBot({ level: 5, junk: 1 }, options), { bot: { level: 5 }, name: 'Stockfish level 5' });
  assert.equal(chess.validateBot({ level: 1 }, { ...options, variant: 'atomic' }).name, 'Computer level 1');
  for (const bad of [{}, { level: 0 }, { level: 9 }, { level: 2.5 }, { level: '3' }]) {
    assert.ok(chess.validateBot(bad, options).error, JSON.stringify(bad));
  }
  // The match says which seat is a bot's; its moves come in like any others.
  const bots = [null, { level: 5 }];
  const match = chess.createMatch({ players: ['white', 'Stockfish level 5'], options, bots, onChange() {} });
  assert.deepEqual(match.snapshot(0).bots, bots);
  assert.equal(match.handle(0, { action: 'move', from: 12, to: 28 }), null);
  assert.equal(match.handle(1, { action: 'move', from: 52, to: 36, bot: true }), null);
  assert.deepEqual(newMatch().match.snapshot(null).bots, [null, null]);
});

function newMatch(options) {
  const changes = [];
  const match = chess.createMatch({
    players: ['white', 'black'],
    options: { variant: 'standard', minutes: 3, increment: 1, ...options },
    onChange: (m) => changes.push(m.snapshot(0)),
  });
  return { match, changes };
}

test('moves, turn order and the increment', () => {
  const { match, changes } = newMatch();
  assert.match(match.handle(1, { action: 'move', from: 52, to: 36 }), /turn/);
  assert.match(match.handle(0, { action: 'move', from: 12, to: 36 }), /Illegal/);
  assert.match(match.handle(0, { action: 'dance' }), /Unknown/);
  assert.equal(match.handle(0, { action: 'move', from: 12, to: 28 }), null);
  const snap = changes.at(-1);
  assert.deepEqual(snap.moves, ['e4']);
  assert.deepEqual(snap.lastMove, { from: 12, to: 28 });
  // The moves are also sent in a form the browser can replay.
  assert.deepEqual(JSON.parse(JSON.stringify(snap.played)), [{ from: 12, to: 28 }]);
  const replayed = applyMove(createGame(variants.standard), snap.played[0]);
  assert.deepEqual(serialize(replayed), snap.state);
  assert.equal(snap.running, 1);
  assert.ok(snap.clocks[0] > 180_000 && snap.clocks[0] <= 181_000);
  assert.deepEqual(snap.options, { variant: 'standard', minutes: 3, increment: 1 });
  // The clocks as they stood after the move: white's with the increment, black's untouched.
  assert.deepEqual(snap.clockHistory, [[snap.clocks[0], 180_000]]);
  const thumb = chess.preview(match.snapshot(null));
  assert.deepEqual([thumb.variant, thumb.pieces.length, thumb.pieces[28], thumb.pieces[12], thumb.pieces[60]],
    ['standard', 64, 'p0', '', 'k1']);
  assert.deepEqual([thumb.lastMove, thumb.checked], [{ from: 12, to: 28 }, []]);
  // A spectator has no seat, and the players are told how many are watching.
  assert.equal(match.snapshot(null).you, null);
  match.setSpectators(2);
  assert.equal(changes.at(-1).spectators, 2);
  match.handle(0, { action: 'resign' });
});

test('draw offers and resignation', () => {
  let { match, changes } = newMatch();
  match.handle(0, { action: 'offerDraw' });
  assert.equal(changes.at(-1).drawOffer, 0);
  // The player who offered cannot accept their own offer.
  match.handle(0, { action: 'acceptDraw' });
  assert.equal(match.over, null);
  match.handle(1, { action: 'declineDraw' });
  assert.equal(changes.at(-1).drawOffer, null);
  match.handle(1, { action: 'offerDraw' });
  match.handle(0, { action: 'acceptDraw' });
  assert.deepEqual(match.over, { reason: 'agreement', winner: null });

  ({ match, changes } = newMatch());
  match.handle(1, { action: 'resign' });
  assert.deepEqual(match.over, { reason: 'resign', winner: 0 });
  assert.match(match.handle(0, { action: 'move', from: 12, to: 28 }), /over/);
});

test('variants: a random start position and drops from the pocket', () => {
  const { match, changes } = newMatch({ variant: 'chess960' });
  const snap = match.snapshot(0);
  assert.ok(Number.isInteger(snap.start) && snap.start >= 0 && snap.start < 960);
  assert.deepEqual(serialize(createGame(variants.chess960, snap.start)), snap.state);
  assert.equal(newMatch().match.snapshot(0).start, null);
  match.handle(0, { action: 'resign' });
  assert.equal(changes.at(-1).over.winner, 1);

  const house = newMatch({ variant: 'crazyhouse' });
  for (const [seat, from, to] of [[0, 12, 28], [1, 51, 35], [0, 28, 35], [1, 59, 35]]) {
    assert.equal(house.match.handle(seat, { action: 'move', from, to }), null);
  }
  assert.match(house.match.handle(0, { action: 'move', drop: 'q', to: 28 }), /Illegal/);
  assert.equal(house.match.handle(0, { action: 'move', drop: 'p', to: 28 }), null);
  const after = house.changes.at(-1);
  assert.deepEqual([after.moves.at(-1), after.state.pockets[0].p, after.lastMove.to], ['P@e4', 0, 28]);
  assert.deepEqual(JSON.parse(JSON.stringify(after.played.at(-1))), { to: 28, drop: 'p' });
  house.match.handle(0, { action: 'resign' });
});

test('running out of time loses', async () => {
  const { match, changes } = newMatch({ minutes: 0.002, increment: 0 });
  match.handle(0, { action: 'move', from: 12, to: 28 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(match.over, { reason: 'timeout', winner: 0 });
  assert.equal(changes.at(-1).clocks[1], 0);
});

test('a 16x16 game through the lobby', async (t) => {
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const alice = connect(server.port);
  const bob = connect(server.port);
  await Promise.all([alice.opened, bob.opened]);
  alice.send({ type: 'join', name: 'alice' });
  bob.send({ type: 'join', name: 'bob' });
  assert.ok((await alice.next('joined')).games.some((g) => g.id === 'chess'));
  await alice.next('users', (m) => m.users.length === 2);

  alice.send({ type: 'invite', to: 'bob', game: 'chess', options: { minutes: 500, increment: 1 } });
  await alice.next('error');
  alice.send({ type: 'invite', to: 'bob', game: 'chess', options: { minutes: 5, increment: 1, variant: 'double' } });
  const invite = await bob.next('invite');
  assert.deepEqual(invite.options, { variant: 'double', minutes: 5, increment: 1 });
  bob.send({ type: 'accept', id: invite.id });
  const [first] = await Promise.all([alice.next('match'), bob.next('match')]);
  assert.equal(first.game, 'chess');
  assert.equal(first.snapshot.state.board.length, 256);

  // b2-b4 on the wide board: squares are numbered y * 16 + x.
  const white = first.snapshot.you === 0 ? alice : bob;
  white.send({ type: 'action', action: 'move', from: 16 + 1, to: 48 + 1 });
  assert.deepEqual((await white.next('match', (m) => m.snapshot.moves.length === 1)).snapshot.moves, ['b4']);

  // The browser can fetch the rules engine but not the server code.
  const get = async (path) => (await fetch(`http://localhost:${server.port}${path}`)).status;
  assert.equal(await get('/games/chess/shared/engine.js'), 200);
  assert.equal(await get('/games/chess/client/index.js'), 200);
  const font = await fetch(`http://localhost:${server.port}/games/chess/client/font/lichess.woff2`);
  assert.deepEqual([font.status, font.headers.get('content-type')], [200, 'font/woff2']);
  assert.equal(await get('/games/chess/server/match.js'), 404);
});

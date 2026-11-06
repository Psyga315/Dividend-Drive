// Rules played through step(): buyouts, debt, auctions, promotion, stocks, movement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, legalActions } from '../src/engine/index.ts';
import { STARTER_BOARD } from '../src/boards/starter.ts';
import { P1, P2, P3, P4, act, cash, give, newGame, phaseOf, readyToMove, types } from './helpers.ts';

const allSuits = ['spade', 'heart', 'diamond', 'club'] as const;

test('§15.6 buyout: pay 5x value, owner gets 3x, bank keeps 2x', () => {
  const s = newGame();
  give(s, P2, 14); // C1, value 200, fee 34
  readyToMove(s, P1, 13, 12, 1);
  let r = act(s, P1, { type: 'move', path: [14] });
  assert.deepEqual(types(r.events), ['moved', 'feePaid']);
  assert.equal(phaseOf(r.state), 'buyout');
  assert.deepEqual(legalActions(r.state)?.choices, [{ type: 'buyout', price: 1000 }, { type: 'pass' }]);
  r = act(r.state, P1, { type: 'buyout' });
  assert.deepEqual(cash(r.state), [1500 - 34 - 1000, 1500 + 34 + 600, 1500, 1500]);
  assert.equal(r.state.shops[14].owner, P1);
  assert.equal(r.state.shops[14].value, 200);
  assert.equal(phaseOf(r.state), 'preRoll');
  assert.equal(r.state.turn.player, P2);
});

test('§15.7 debt: sell a shop to the bank for 75%, then auction it', () => {
  const s = newGame();
  give(s, P1, 14); // value 200
  give(s, P2, 29); // E4, value 530, fee 105
  s.players[P1].cash = 20;
  readyToMove(s, P1, 0, null, 1);
  let r = act(s, P1, { type: 'move', path: [29] });
  assert.equal(r.state.players[P1].cash, -85);
  assert.equal(phaseOf(r.state), 'debt');
  assert.deepEqual(legalActions(r.state)?.choices, [{ type: 'sellShop', square: 14, bankPays: 150 }]);
  r = act(r.state, P1, { type: 'sellShop', square: 14 });
  assert.equal(r.state.players[P1].cash, 65);
  assert.deepEqual(legalActions(r.state), { player: P2, choices: [{ type: 'bid', min: 200, max: 1605 }, { type: 'pass' }] });
  r = act(r.state, P2, { type: 'pass' });
  r = act(r.state, P3, { type: 'bid', amount: 250 });
  r = act(r.state, P4, { type: 'bid', amount: 250 }); // tie: later in turn order wins
  assert.equal(r.state.shops[14].owner, P4);
  assert.deepEqual(cash(r.state), [65, 1605, 1500, 1250]);
  assert.equal(phaseOf(r.state), 'preRoll');
  assert.equal(r.state.turn.player, P2);
});

test('auction with no bids leaves the shop unowned', () => {
  const s = newGame();
  give(s, P1, 14);
  give(s, P2, 29);
  s.players[P1].cash = 20;
  for (const p of [P2, P3, P4]) s.players[p].cash = 90; // even P2, after collecting the 105 fee, has under 200
  readyToMove(s, P1, 0, null, 1);
  let r = act(s, P1, { type: 'move', path: [29] });
  r = act(r.state, P1, { type: 'sellShop', square: 14 });
  assert.ok(types(r.events).includes('auctionNoBids'));
  assert.equal(r.state.shops[14].owner, null);
  assert.equal(phaseOf(r.state), 'preRoll');
});

test('bankruptcy ends the game (bankruptcyLimit 1); highest net worth wins', () => {
  const s = newGame();
  give(s, P2, 29);
  s.players[P1].cash = 20;
  readyToMove(s, P1, 0, null, 1);
  const r = act(s, P1, { type: 'move', path: [29] });
  assert.ok(r.state.players[P1].bankrupt);
  assert.deepEqual(r.state.phase, { kind: 'gameOver', winner: P2, reason: 'bankruptcy' });
});

test('§15.4 dividends are paid when a fee is paid', () => {
  const s = newGame();
  give(s, P2, 14, 15, 17, 18); // P2 owns all of C: fee at C1 is 170
  s.players[P3].shares.C = 30;
  s.players[P4].shares.C = 10;
  readyToMove(s, P1, 13, 12, 1);
  const r = act(s, P1, { type: 'move', path: [14] });
  assert.deepEqual(cash(r.state), [1330, 1670, 1525, 1508]);
  assert.deepEqual(types(r.events), ['moved', 'feePaid', 'dividend', 'dividend']);
});

test('closed shops charge no fee and pay no dividends, but can be bought out', () => {
  const s = newGame();
  give(s, P2, 14);
  s.players[P2].shopsClosed = true;
  s.players[P3].shares.C = 30;
  readyToMove(s, P1, 13, 12, 1);
  const r = act(s, P1, { type: 'move', path: [14] });
  assert.deepEqual(cash(r.state), [1500, 1500, 1500, 1500]);
  assert.equal(phaseOf(r.state), 'buyout');
});

test('take-a-break closes your shops until your next turn', () => {
  const s = newGame();
  readyToMove(s, P1, 24, 23, 1);
  let r = act(s, P1, { type: 'move', path: [25] });
  assert.ok(r.state.players[P1].shopsClosed);
  r.state.turn.player = P4;
  r.state.phase = { kind: 'move', remaining: 1 };
  r.state.players[P4].position = 24;
  r.state.players[P4].cameFrom = 23;
  r = act(r.state, P4, { type: 'move', path: [25] });
  assert.equal(r.state.turn.player, P1);
  assert.equal(r.state.players[P1].shopsClosed, false);
});

test('§9 promotion when passing the bank mid-move, then movement continues forward', () => {
  const s = newGame();
  s.players[P1].suits = [...allSuits];
  give(s, P1, 1, 26, 14); // shops worth 600
  readyToMove(s, P1, 2, 3, 3);
  assert.deepEqual(legalActions(s)?.choices, [{ type: 'move', path: [1, 0] }]); // path stops at the bank
  let r = act(s, P1, { type: 'move', path: [1, 0] });
  assert.deepEqual(types(r.events), ['moved', 'promoted']);
  assert.equal(r.state.players[P1].cash, 1960);
  assert.equal(r.state.players[P1].level, 2);
  assert.deepEqual(r.state.players[P1].suits, []);
  assert.equal(phaseOf(r.state), 'buyStock');
  r = act(r.state, P1, { type: 'pass' });
  assert.deepEqual(r.state.phase, { kind: 'move', remaining: 1 });
  assert.deepEqual(legalActions(r.state)?.choices, [{ type: 'move', path: [25] }, { type: 'move', path: [29] }]); // no U-turn to 1
});

test('a Suit Yourself wildcard fills a missing suit', () => {
  const s = newGame();
  s.players[P1].suits = ['spade', 'heart', 'diamond'];
  s.players[P1].wildcards = 2;
  readyToMove(s, P1, 1, 2, 1);
  const r = act(s, P1, { type: 'move', path: [0] });
  assert.ok(types(r.events).includes('promoted'));
  assert.equal(r.state.players[P1].wildcards, 1);
});

test('suits are collected when passing, and only once', () => {
  const s = newGame();
  s.players[P1].suits = ['spade'];
  readyToMove(s, P1, 2, 1, 3);
  const r = act(s, P1, { type: 'move', path: [3, 4, 5] });
  assert.deepEqual(r.state.players[P1].suits, ['spade']);
  assert.ok(!types(r.events).includes('suitCollected'));
});

test('§1 reaching the bank with net worth >= target wins', () => {
  const s = newGame({ targetNetWorth: 1600 });
  s.players[P1].cash = 1700;
  readyToMove(s, P1, 1, 2, 1);
  const r = act(s, P1, { type: 'move', path: [0] });
  assert.deepEqual(r.state.phase, { kind: 'gameOver', winner: P1, reason: 'target' });
});

test('below the target, the bank just offers stocks', () => {
  const s = newGame({ targetNetWorth: 1600 });
  readyToMove(s, P1, 1, 2, 1);
  const r = act(s, P1, { type: 'move', path: [0] });
  assert.equal(phaseOf(r.state), 'buyStock');
});

test('§19 later seats start with catch-up cash (default +125G each), after shuffling', () => {
  const s = createGame({ board: STARTER_BOARD, players: ['a', 'b', 'c', 'd'], seed: 3 });
  assert.deepEqual(cash(s), [1500, 1625, 1750, 1875]);
  assert.equal(s.config.targetNetWorth, 8000);
});

test('suit events say whether the suit was passed or landed on', () => {
  const s = newGame();
  readyToMove(s, P1, 2, 1, 2);
  const passed = act(s, P1, { type: 'move', path: [3, 4] }).events.find((e) => e.type === 'suitCollected');
  assert.deepEqual(passed, { type: 'suitCollected', player: P1, suit: 'spade', onTheWay: true });
  readyToMove(s, P1, 2, 1, 1);
  const landed = act(s, P1, { type: 'move', path: [3] }).events.find((e) => e.type === 'suitCollected');
  assert.deepEqual(landed, { type: 'suitCollected', player: P1, suit: 'spade', onTheWay: false });
});
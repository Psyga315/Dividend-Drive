// Stocks (§8), investing (§6), buying shops (§5.4-5.5), movement (§4.1), action validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { IllegalActionError, enumeratePaths, indexBoard, legalActions, stockPrice } from '../src/engine/index.ts';
import { STARTER_BOARD } from '../src/boards/starter.ts';
import { P1, P2, act, give, newGame, phaseOf, readyToMove, types } from './helpers.ts';

const board = indexBoard(STARTER_BOARD);

test('§8.3 buying 10+ shares raises the price 10% at end of turn', () => {
  const s = newGame();
  readyToMove(s, P1, 11, 10, 1);
  let r = act(s, P1, { type: 'move', path: [12] }); // stockbroker
  assert.equal(phaseOf(r.state), 'buyStock');
  r = act(r.state, P1, { type: 'buyStock', district: 'C', qty: 10 });
  assert.equal(r.state.players[P1].cash, 1400);
  assert.equal(r.state.players[P1].shares.C, 10);
  assert.deepEqual(r.events.find((e) => e.type === 'stockPriceChanged'), {
    type: 'stockPriceChanged', district: 'C', oldPrice: 10, newPrice: 11, reason: 'largeBuy',
  });
  assert.equal(r.state.turn.player, P2);
});

test('§8.3 buying 9 shares does not move the price', () => {
  const s = newGame();
  readyToMove(s, P1, 11, 10, 1);
  let r = act(s, P1, { type: 'move', path: [12] });
  r = act(r.state, P1, { type: 'buyStock', district: 'C', qty: 9 });
  assert.ok(!types(r.events).includes('stockPriceChanged'));
  assert.equal(stockPrice(r.state, 'C'), 10);
});

test('§8.3 selling 10+ shares before rolling drops the price at end of turn', () => {
  const s = newGame();
  s.players[P1].shares.C = 20;
  let r = act(s, P1, { type: 'sellStock', district: 'C', qty: 10 });
  assert.equal(phaseOf(r.state), 'preRoll'); // may keep selling, then roll
  assert.equal(r.state.players[P1].cash, 1600);
  readyToMove(r.state, P1, 24, 23, 1); // keeps this turn's trades
  r.state.turn.netTrades = { [P1]: { C: -10 } };
  r = act(r.state, P1, { type: 'move', path: [25] });
  assert.deepEqual(r.events.find((e) => e.type === 'stockPriceChanged'), {
    type: 'stockPriceChanged', district: 'C', oldPrice: 10, newPrice: 9, reason: 'largeSell',
  });
});

test('§8.3 selling 10 and buying 10 in the same turn cancel out', () => {
  const s = newGame();
  s.players[P1].shares.C = 20;
  let r = act(s, P1, { type: 'sellStock', district: 'C', qty: 10 });
  const trades = r.state.turn.netTrades;
  readyToMove(r.state, P1, 11, 10, 1);
  r.state.turn.netTrades = trades;
  r = act(r.state, P1, { type: 'move', path: [12] });
  r = act(r.state, P1, { type: 'buyStock', district: 'C', qty: 10 });
  assert.ok(!types(r.events).includes('stockPriceChanged'));
});

test('§6 investing raises shop value and stock price; turn ends when nothing is left to invest', () => {
  const s = newGame();
  give(s, P1, 14); // only shop in C: max capital 100
  readyToMove(s, P1, 13, 12, 1);
  let r = act(s, P1, { type: 'move', path: [14] });
  assert.deepEqual(legalActions(r.state)?.choices, [{ type: 'invest', square: 14, maxAmount: 100 }, { type: 'pass' }]);
  r = act(r.state, P1, { type: 'invest', square: 14, amount: 100 });
  assert.equal(r.state.shops[14].value, 300);
  assert.equal(r.state.players[P1].cash, 1400);
  assert.equal(stockPrice(r.state, 'C'), 11); // average (300+230+260+310)/4 = 275
  assert.equal(r.state.turn.player, P2);
});

test('§6 investing is capped at 999 per turn', () => {
  const s = newGame();
  give(s, P1, 26, 27, 28, 29); // all of E: huge max capital
  s.players[P1].cash = 5000;
  readyToMove(s, P1, 0, null, 1);
  let r = act(s, P1, { type: 'move', path: [29] });
  assert.throws(() => act(r.state, P1, { type: 'invest', square: 29, amount: 1000 }), IllegalActionError);
  r = act(r.state, P1, { type: 'invest', square: 29, amount: 600 });
  assert.equal(phaseOf(r.state), 'invest');
  r = act(r.state, P1, { type: 'invest', square: 28, amount: 399 });
  assert.equal(r.state.players[P1].cash, 4001);
  assert.equal(r.state.turn.player, P2); // 999 used, turn over
});

test('§5.4 buying an unowned shop', () => {
  const s = newGame();
  readyToMove(s, P1, 0, null, 1);
  let r = act(s, P1, { type: 'move', path: [1] });
  assert.deepEqual(legalActions(r.state)?.choices, [{ type: 'buyShop', price: 100 }, { type: 'pass' }]);
  r = act(r.state, P1, { type: 'buyShop' });
  assert.equal(r.state.shops[1].owner, P1);
  assert.equal(r.state.players[P1].cash, 1400);
});

test('§5.5 stocks count toward spending; the debt is covered at end of turn', () => {
  const s = newGame();
  s.players[P1].cash = 50;
  s.players[P1].shares.E = 20; // 20 x 17 = 340
  readyToMove(s, P1, 0, null, 1);
  let r = act(s, P1, { type: 'move', path: [1] });
  r = act(r.state, P1, { type: 'buyShop' });
  assert.equal(r.state.players[P1].cash, -50);
  assert.deepEqual(r.state.phase, { kind: 'debt', player: P1 });
  r = act(r.state, P1, { type: 'sellStock', district: 'E', qty: 3 });
  assert.equal(r.state.players[P1].cash, 1);
  assert.equal(r.state.turn.player, P2);
});

test('§5.5 a shop you cannot afford, even with stocks, is not offered', () => {
  const s = newGame();
  s.players[P1].cash = 50;
  readyToMove(s, P1, 0, null, 1);
  const r = act(s, P1, { type: 'move', path: [1] });
  assert.equal(r.state.turn.player, P2);
});

test('§4.1 movement: no U-turns, free choice from the bank, branches at junctions', () => {
  assert.deepEqual(enumeratePaths(board, 2, 3, 1), [[1]]);
  assert.deepEqual(enumeratePaths(board, 0, null, 1), [[1], [25], [29]]);
  assert.deepEqual(enumeratePaths(board, 13, 12, 2), [[14, 15], [26, 27]]);
  assert.deepEqual(enumeratePaths(board, 12, 11, 3), [[13, 14, 15], [13, 26, 27]]);
});

test('action validation: wrong player, bad amounts and wrong phase all throw', () => {
  const s = newGame();
  assert.throws(() => act(s, P2, { type: 'roll' }), IllegalActionError);
  assert.throws(() => act(s, P1, { type: 'buyShop' }), IllegalActionError);
  readyToMove(s, P1, 11, 10, 1);
  const r = act(s, P1, { type: 'move', path: [12] });
  assert.throws(() => act(r.state, P1, { type: 'buyStock', district: 'C', qty: 100 }), IllegalActionError);
  assert.throws(() => act(r.state, P1, { type: 'buyStock', district: 'C', qty: 2.5 }), IllegalActionError);
  assert.throws(() => act(r.state, P1, { type: 'buyStock', district: 'Z', qty: 1 }), IllegalActionError);
  assert.throws(() => act(s, P1, { type: 'move', path: [10] }), IllegalActionError); // U-turn
});

test('step() never changes the state it is given', () => {
  const s = newGame();
  readyToMove(s, P1, 11, 10, 1);
  const before = JSON.stringify(s);
  const r = act(s, P1, { type: 'move', path: [12] });
  act(r.state, P1, { type: 'buyStock', district: 'C', qty: 10 });
  assert.equal(JSON.stringify(s), before);
});
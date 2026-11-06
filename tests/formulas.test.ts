// RULES.md §14 and §15: the worked examples, checked against the formulas.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultBaseFee, dividendShare, feeFor, maxCapitalFor, priceFor, salary, shopFee, shopMaxCapital, stockPrice, validateBoard,
} from '../src/engine/index.ts';
import { STARTER_BOARD } from '../src/boards/starter.ts';
import { P1, give, newGame } from './helpers.ts';

test('starter board is valid', () => {
  assert.deepEqual(validateBoard(STARTER_BOARD), []);
});

test('§15.1 base fee formula', () => {
  assert.equal(defaultBaseFee(100), 13);
  assert.equal(defaultBaseFee(200), 34);
  assert.equal(defaultBaseFee(500), 99);
  assert.equal(defaultBaseFee(1000), 200);
});

// [shops owned in district, fee at value 200, max capital, fee after investing the max]
const TABLE_15_2 = [
  [1, 34, 100, 68],
  [2, 42, 200, 127],
  [3, 85, 600, 595],
  [4, 170, 1800, 3230],
];

test('§15.2 fee and max capital (formulas)', () => {
  for (const [owned, fee, cap, feeAtMax] of TABLE_15_2) {
    assert.equal(feeFor(34, 200, 200, 4, owned), fee, `fee, owned ${owned}`);
    assert.equal(maxCapitalFor(200, 200, 4, owned), cap, `max capital, owned ${owned}`);
    assert.equal(feeFor(34, 200, 200 + cap, 4, owned), feeAtMax, `fee at max, owned ${owned}`);
  }
});

test('§15.2 fee and max capital (through a game state, shop C1 = square 14)', () => {
  const districtC = [14, 15, 17, 18];
  for (const [owned, fee, cap, feeAtMax] of TABLE_15_2) {
    const s = newGame();
    give(s, P1, ...districtC.slice(0, owned));
    assert.equal(shopFee(s, 14), fee);
    assert.equal(shopMaxCapital(s, 14), cap);
    s.shops[14].value += cap;
    assert.equal(shopFee(s, 14), feeAtMax);
    assert.equal(shopMaxCapital(s, 14), 0);
  }
});

test('§14 starting stock prices on the starter board', () => {
  const s = newGame();
  const prices = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((d) => [d, stockPrice(s, d)]));
  assert.deepEqual(prices, { A: 6, B: 8, C: 10, D: 12, E: 17 });
});

test('§14 starter shop base fees', () => {
  const fees = STARTER_BOARD.squares.flatMap((sq) => (sq.type === 'shop' ? [defaultBaseFee(sq.baseValue)] : []));
  assert.deepEqual(fees, [13, 17, 25, 30, 23, 30, 38, 45, 34, 41, 47, 58, 43, 52, 60, 69, 56, 67, 82, 105]);
});

test('§15.3 stock price follows shop values and the multiplier', () => {
  assert.equal(priceFor(250, 2816), 10);
  const s = newGame();
  s.shops[14].value += 400; // district C average 250 -> 350
  assert.equal(stockPrice(s, 'C'), 15);
  const s2 = newGame();
  s2.stockMult.C = Math.round((s2.stockMult.C * 110) / 100);
  assert.equal(stockPrice(s2, 'C'), 11);
});

test('§15.4 dividend split', () => {
  assert.equal(dividendShare(34, 30, 40, 5), 25);
  assert.equal(dividendShare(34, 10, 40, 5), 8);
  assert.equal(dividendShare(34, 3, 3, 5), 20); // sole holder with fewer than 5 shares
  assert.equal(dividendShare(34, 5, 5, 5), 34);
});

test('§15.5 salary: level 1 with 600 in shops = 460', () => {
  const s = newGame();
  give(s, P1, 1, 26, 14); // 100 + 300 + 200
  assert.equal(salary(s, P1), 460);
});
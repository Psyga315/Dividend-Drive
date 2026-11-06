// Stress test: random players pick random legal actions for many whole games.
// After every action we check that the state still makes sense.
import test from 'node:test';
import assert from 'node:assert/strict';
import { indexBoard, legalActions, makeRandom, step, type ActionBody, type ActionPrompt, type Config, type GameState } from '../src/engine/index.ts';
import { newGame } from './helpers.ts';

function randomAction(prompt: ActionPrompt, rand: () => number): ActionBody {
  const ch = prompt.choices[Math.floor(rand() * prompt.choices.length)];
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  switch (ch.type) {
    case 'move': return { type: 'move', path: ch.path };
    case 'sellStock': return { type: 'sellStock', district: ch.district, qty: between(1, ch.maxQty) };
    case 'buyStock': return { type: 'buyStock', district: ch.district, qty: between(1, ch.maxQty) };
    case 'invest': return { type: 'invest', square: ch.square, amount: between(1, ch.maxAmount) };
    case 'chooseDistrict': return { type: 'chooseDistrict', district: ch.district };
    case 'sellShop': return { type: 'sellShop', square: ch.square };
    case 'bid': return { type: 'bid', amount: between(ch.min, ch.max) };
    default: return { type: ch.type };
  }
}

function checkState(s: GameState): void {
  const b = indexBoard(s.board);
  for (const [i, p] of s.players.entries()) {
    assert.ok(Number.isInteger(p.cash), `P${i + 1} cash is not a whole number: ${p.cash}`);
    for (const [d, n] of Object.entries(p.shares)) assert.ok(Number.isInteger(n) && n >= 0, `P${i + 1} has ${n} shares of ${d}`);
    assert.ok(b.byId.has(p.position), `P${i + 1} is on a missing square`);
    if (s.phase.kind === 'preRoll') assert.ok(p.bankrupt || p.cash >= 0, `P${i + 1} starts a turn in debt`);
  }
  for (const [id, shop] of Object.entries(s.shops)) {
    assert.ok(Number.isInteger(shop.value) && shop.value >= 1, `shop ${id} value ${shop.value}`);
    if (shop.owner !== null) assert.ok(!s.players[shop.owner].bankrupt, `bankrupt player owns shop ${id}`);
  }
  for (const m of Object.values(s.stockMult)) assert.ok(Number.isInteger(m) && m >= 1);
}

function playRandomGame(config: Partial<Config>, seed: number, checkImmutable = false): { state: GameState; steps: number } {
  let state = newGame({ maxRounds: 40, ...config }, seed);
  const rand = makeRandom(seed * 7919);
  let steps = 0;
  for (let prompt = legalActions(state); prompt; prompt = legalActions(state)) {
    assert.ok(prompt.choices.length > 0, `no choices during ${state.phase.kind}`);
    const before = checkImmutable ? JSON.stringify(state) : '';
    const next = step(state, { ...randomAction(prompt, rand), player: prompt.player }).state;
    if (checkImmutable) assert.equal(JSON.stringify(state), before, `step() changed its input during ${state.phase.kind}`);
    state = next;
    checkState(state);
    if (++steps > 50_000) assert.fail('game did not end');
  }
  return { state, steps };
}

for (const ventureCards of [false, true]) {
  test(`120 random games end cleanly (venture cards ${ventureCards ? 'on' : 'off'})`, () => {
    const reasons: Record<string, number> = {};
    for (let seed = 1; seed <= 120; seed++) {
      const { state } = playRandomGame({ ventureCards, initialCash: 1500 + 300 * (seed % 5), targetNetWorth: 3000 + 500 * (seed % 7) }, seed);
      assert.equal(state.phase.kind, 'gameOver');
      if (state.phase.kind === 'gameOver') reasons[state.phase.reason] = (reasons[state.phase.reason] ?? 0) + 1;
    }
    assert.ok(Object.keys(reasons).length >= 2, `expected a mix of endings, got ${JSON.stringify(reasons)}`);
  });
}

test('same seed, same actions: identical game; step() never changes its input', () => {
  const a = playRandomGame({ ventureCards: true }, 42, true);
  const b = playRandomGame({ ventureCards: true }, 42);
  assert.equal(a.steps, b.steps);
  assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
});
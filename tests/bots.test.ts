// Bots must only make legal moves, and games between bots must finish.
// (playGame throws if a bot ever picks an action the engine doesn't allow.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { STARTER_BOARD } from '../src/boards/starter.ts';
import { BOTS, playGame } from '../src/bots/index.ts';

const MIX = ['balanced', 'landlord', 'trader', 'random'];

for (const ventureCards of [false, true]) {
  test(`bots play 40 full games without an illegal move (venture cards ${ventureCards ? 'on' : 'off'})`, () => {
    for (let seed = 1; seed <= 40; seed++) {
      const bots = MIX.map((_, i) => BOTS[MIX[(i + seed) % MIX.length]]());
      const final = playGame({ board: STARTER_BOARD, bots, config: { ventureCards, maxRounds: 100 }, seed });
      assert.equal(final.phase.kind, 'gameOver');
    }
  });
}

test('bot games replay identically from the same seed', () => {
  const run = () => playGame({ board: STARTER_BOARD, bots: MIX.map((name) => BOTS[name]()), config: { maxRounds: 100 }, seed: 7 });
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
});
// Bot-vs-bot simulations for balance testing.
//
//   npm run sim                                    1000 games, 4 balanced bots, default settings
//   node scripts/simulate.ts --games 200 --cash 2000 --target 8000
//   node scripts/simulate.ts --bots balanced,landlord,trader,balanced
//   node scripts/simulate.ts --ventures --max-rounds 60 --seed 7
//   node scripts/simulate.ts --log                 print one full game instead of statistics
//
// (Options go straight to node: PowerShell can swallow the "--" in "npm run sim -- ...".)
//
// Bots swap seats every game, so no bot always goes first.
import { STARTER_BOARD } from '../src/boards/starter.ts';
import { BOTS, playGame, type Bot } from '../src/bots/index.ts';
import { describeEvent, gold } from '../src/describe.ts';
import { DEFAULT_CONFIG, netWorth, shopsValue, stockValue, type Config, type GameEvent, type GameState } from '../src/engine/index.ts';

// ---------- Command-line options ----------

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const numberOption = (name: string, fallback: number): number => {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${name} needs a number, got "${raw}"`);
  return n;
};

const games = numberOption('games', 1000);
const firstSeed = numberOption('seed', 1);
const botNames = (option('bots') ?? 'balanced,balanced,balanced,balanced').split(',').map((n) => n.trim());
for (const n of botNames) if (!BOTS[n]) throw new Error(`Unknown bot "${n}". Choose from: ${Object.keys(BOTS).join(', ')}`);
const config: Partial<Config> = {
  initialCash: numberOption('cash', DEFAULT_CONFIG.initialCash),
  seatCashBonus: numberOption('seat-bonus', DEFAULT_CONFIG.seatCashBonus),
  targetNetWorth: numberOption('target', DEFAULT_CONFIG.targetNetWorth),
  ventureCards: args.includes('--ventures'),
  maxRounds: numberOption('max-rounds', 100),
};

/** Game g seats the bots rotated by g, so every bot takes every seat equally often. */
const seatBots = (g: number): Bot[] => botNames.map((_, i) => BOTS[botNames[(i + g) % botNames.length]]());

if (args.includes('--log')) {
  printOneGame();
} else {
  runBatch();
}

// ---------- One game, fully logged ----------

function printOneGame(): void {
  let first = true;
  const final = playGame({
    board: STARTER_BOARD,
    bots: seatBots(0),
    config,
    seed: firstSeed,
    onStep: (state, events) => {
      if (first) {
        console.log(`--- Round 1: ${state.players[0].name} ---`);
        first = false;
      }
      for (const e of events) console.log(describeEvent(state, e));
    },
  });
  console.log('\nFinal standings:');
  printStandings(final);
}

function printStandings(s: GameState): void {
  for (const [i, p] of s.players.entries()) {
    const parts = `cash ${gold(p.cash)} + shops ${gold(shopsValue(s, i))} + stocks ${gold(stockValue(s, i))}`;
    console.log(`  ${p.name.padEnd(16)} ${gold(netWorth(s, i)).padStart(8)}  (${parts}), level ${p.level}${p.bankrupt ? ', BANKRUPT' : ''}`);
  }
}

// ---------- Many games, summarized ----------

interface GameStats {
  rounds: number;
  reason: string;
  winnerSeat: number;
  winnerBot: string;
  winnerMix: { cash: number; shops: number; stocks: number };
  finals: { bot: string; netWorth: number }[];
  counts: Record<string, number>;
  feesPaid: number;
  biggestFee: number;
  dividends: number;
  invested: number;
  stockSpend: number;
}

function runOne(g: number): GameStats {
  const bots = seatBots(g);
  const stats: GameStats = {
    rounds: 0, reason: '', winnerSeat: -1, winnerBot: '', winnerMix: { cash: 0, shops: 0, stocks: 0 }, finals: [],
    counts: {}, feesPaid: 0, biggestFee: 0, dividends: 0, invested: 0, stockSpend: 0,
  };
  const count = (e: GameEvent) => {
    stats.counts[e.type] = (stats.counts[e.type] ?? 0) + 1;
    if (e.type === 'feePaid') {
      stats.feesPaid += e.amount;
      stats.biggestFee = Math.max(stats.biggestFee, e.amount);
    } else if (e.type === 'dividend') stats.dividends += e.amount;
    else if (e.type === 'invested') stats.invested += e.amount;
    else if (e.type === 'stockBought') stats.stockSpend += e.qty * e.pricePerShare;
  };
  const final = playGame({ board: STARTER_BOARD, bots, config, seed: firstSeed + g, onStep: (_s, events) => events.forEach(count) });
  if (final.phase.kind !== 'gameOver') throw new Error('Game did not finish');
  const w = final.phase.winner;
  stats.rounds = final.round;
  stats.reason = final.phase.reason;
  stats.winnerSeat = w;
  stats.winnerBot = bots[w].name;
  const total = Math.max(1, netWorth(final, w));
  stats.winnerMix = { cash: final.players[w].cash / total, shops: shopsValue(final, w) / total, stocks: stockValue(final, w) / total };
  stats.finals = bots.map((bot, i) => ({ bot: bot.name, netWorth: netWorth(final, i) }));
  return stats;
}

function runBatch(): void {
  const started = performance.now();
  const all: GameStats[] = [];
  for (let g = 0; g < games; g++) all.push(runOne(g));
  const seconds = (performance.now() - started) / 1000;

  const n = all.length;
  const players = botNames.length;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const pct = (x: number) => `${Math.round(100 * x)}%`;
  const fmt = (x: number) => Math.round(x).toLocaleString('en-US');
  const quantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  const perGame = (type: string) => avg(all.map((g) => g.counts[type] ?? 0));
  const rounds = all.map((g) => g.rounds);
  const line = (label: string, text: string) => console.log(`${label.padEnd(22)}${text}`);

  console.log(`${n} games on ${STARTER_BOARD.name} in ${seconds.toFixed(1)}s`);
  console.log(
    `Bots: ${botNames.join(', ')} | start cash ${fmt(config.initialCash!)} (+${fmt(config.seatCashBonus!)} per later seat) | ` +
      `target ${fmt(config.targetNetWorth!)} | venture cards ${config.ventureCards ? 'on' : 'off'} | round limit ${config.maxRounds}\n`,
  );

  line('Game length (rounds)', `average ${avg(rounds).toFixed(1)}, median ${quantile(rounds, 0.5)}, middle 80%: ${quantile(rounds, 0.1)}-${quantile(rounds, 0.9)}`);
  const reasons = ['target', 'bankruptcy', 'maxRounds'] as const;
  const reasonNames = { target: 'reached target', bankruptcy: 'bankruptcy', maxRounds: 'round limit' };
  line('How games ended', reasons.map((r) => `${reasonNames[r]} ${pct(all.filter((g) => g.reason === r).length / n)}`).join(', '));
  line('Wins by seat', Array.from({ length: players }, (_, i) => `${['1st', '2nd', '3rd', '4th'][i]} ${pct(all.filter((g) => g.winnerSeat === i).length / n)}`).join(', '));

  const distinct = [...new Set(botNames)];
  if (distinct.length > 1) {
    const seatsHeld = (bot: string) => botNames.filter((b) => b === bot).length;
    line('Win rate per seat', distinct.map((b) => `${b} ${pct(all.filter((g) => g.winnerBot === b).length / (n * seatsHeld(b)))}`).join(', ') + ` (fair = ${pct(1 / players)})`);
    line('Avg final net worth', distinct.map((b) => `${b} ${fmt(avg(all.flatMap((g) => g.finals.filter((f) => f.bot === b).map((f) => f.netWorth))))}`).join(', '));
  }

  const mix = (k: 'cash' | 'shops' | 'stocks') => pct(avg(all.map((g) => g.winnerMix[k])));
  line("Winner's net worth", `cash ${mix('cash')}, shops ${mix('shops')}, stocks ${mix('stocks')}`);
  console.log('\nPer game (average)');
  line('  Promotions', `${perGame('promoted').toFixed(1)} (${(perGame('promoted') / players).toFixed(1)} per player)`);
  line('  Shops bought', `${perGame('shopBought').toFixed(1)} (board has ${STARTER_BOARD.squares.filter((s) => s.type === 'shop').length})`);
  line('  Invested', `${fmt(avg(all.map((g) => g.invested)))}G`);
  line('  Fees paid', `${fmt(avg(all.map((g) => g.feesPaid)))}G in ${perGame('feePaid').toFixed(1)} fees; biggest fee seen ${fmt(Math.max(...all.map((g) => g.biggestFee)))}G`);
  line('  Stock purchases', `${fmt(avg(all.map((g) => g.stockSpend)))}G in ${perGame('stockBought').toFixed(1)} trades; dividends ${fmt(avg(all.map((g) => g.dividends)))}G`);
  line('  Buyouts', perGame('boughtOut').toFixed(2));
  line('  Shops sold for debt', perGame('shopSoldToBank').toFixed(2));
  line('  Bankruptcies', perGame('bankrupt').toFixed(2));
  if (config.ventureCards) line('  Venture cards', perGame('cardDrawn').toFixed(1));
}
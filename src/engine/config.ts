import type { Config } from './types.ts';

/** Defaults from RULES.md §2. Percentages are whole numbers (10 = 10%). */
export const DEFAULT_CONFIG: Config = {
  initialCash: 1500,
  seatCashBonus: 125, // each later player in turn order starts with this much more (RULES.md §19)
  targetNetWorth: 8000,
  baseSalary: 250,
  salaryIncrement: 150,
  shopBonusRate: 10,
  dieMax: 6,
  maxInvestPerTurn: 999,
  maxSharesPerPurchase: 99,
  buyoutMultiplier: 5,
  buyoutToOwner: 3,
  debtSaleRate: 75,
  stockMultStart: 2816, // 11/256 ≈ 0.04297, stored in 1/65536 units like the original
  largeTradeThreshold: 10,
  largeTradeStep: 10,
  dividendRate: 20,
  dividendMinShares: 5,
  maxSuitYourself: 9,
  bankruptcyLimit: 1,
  maxRounds: null,
  protectDominatedShops: false,
  ventureCards: false,
  randomTurnOrder: true,
};
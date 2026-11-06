// Money math (RULES.md §5, §8, §9). Pure functions: nothing here changes the state.
import type { DistrictId, GameState, PlayerId, ShopSquare, SquareId, Suit } from './types.ts';
import { indexBoard, shopSquare } from './board.ts';

export const SUITS: readonly Suit[] = ['spade', 'heart', 'diamond', 'club'];

/** 1.0 in stock-multiplier units. */
export const MULT_ONE = 65536;

/** feeMult × 4. Row = shops in the district, column = shops this owner has there (1..N). */
export const FEE_MULT_X4: Readonly<Record<number, readonly number[]>> = {
  1: [4],
  2: [4, 8],
  3: [4, 6, 15],
  4: [4, 5, 10, 20],
  5: [4, 5, 8, 13, 24],
  6: [4, 5, 8, 11, 17, 27],
  7: [4, 5, 7, 11, 15, 21, 30],
  8: [4, 5, 7, 10, 14, 18, 24, 32],
};

/** capMult × 256, same layout as FEE_MULT_X4. */
export const CAP_MULT_X256: Readonly<Record<number, readonly number[]>> = {
  1: [512],
  2: [384, 768],
  3: [384, 576, 1536],
  4: [384, 512, 1024, 2560],
  5: [384, 512, 1024, 2560, 3072],
  6: [384, 512, 1024, 2560, 3072, 3584],
  7: [384, 512, 1024, 2560, 3072, 3584, 4096],
  8: [384, 512, 1024, 2560, 3072, 3584, 4096, 4864],
};

function tableEntry(table: Readonly<Record<number, readonly number[]>>, districtSize: number, owned: number): number {
  const v = table[districtSize]?.[owned - 1];
  if (v === undefined) throw new Error(`No table entry for district size ${districtSize}, owned ${owned}`);
  return v;
}

// ---------- Formulas ----------

/** §5.1: base fee when the board file doesn't set one. */
export function defaultBaseFee(baseValue: number): number {
  return Math.round(baseValue * (0.2 - 0.15 * Math.pow(0.2, baseValue / 200)));
}

/** §5.2: what a visitor pays. */
export function feeFor(baseFee: number, baseValue: number, value: number, districtSize: number, owned: number): number {
  const m = tableEntry(FEE_MULT_X4, districtSize, owned);
  return Math.max(1, Math.floor((baseFee * (2 * value - baseValue) * m) / (4 * baseValue)));
}

/** §5.3: how much more can be invested. */
export function maxCapitalFor(baseValue: number, value: number, districtSize: number, owned: number): number {
  const m = tableEntry(CAP_MULT_X256, districtSize, owned);
  return Math.max(0, Math.floor((baseValue * m) / 256) - value);
}

/** §8.1: stock price from the district's average shop value. */
export function priceFor(averageValue: number, mult: number): number {
  return Math.max(1, Math.floor((averageValue * mult) / MULT_ONE));
}

/** §8.4: one shareholder's cut of a dividend pool. */
export function dividendShare(pool: number, shares: number, totalShares: number, minShares: number): number {
  return Math.floor((pool * shares) / Math.max(totalShares, minShares));
}

/** Price after a percentage change, e.g. adjustPct(100, 10) = 110. Rounded down. */
export function adjustPct(amount: number, pct: number): number {
  return Math.floor((amount * (100 + pct)) / 100);
}

// ---------- Queries on a game state ----------

export function shopBaseFee(sq: ShopSquare): number {
  return sq.baseFee ?? defaultBaseFee(sq.baseValue);
}

export function districtSize(s: GameState, d: DistrictId): number {
  return indexBoard(s.board).districtShops.get(d)?.length ?? 0;
}

export function ownedInDistrict(s: GameState, d: DistrictId, owner: PlayerId): number {
  const ids = indexBoard(s.board).districtShops.get(d) ?? [];
  return ids.filter((id) => s.shops[id].owner === owner).length;
}

/** Fee a visitor would pay right now (0 if unowned). Ignores closed shops. */
export function shopFee(s: GameState, id: SquareId): number {
  const sq = shopSquare(indexBoard(s.board), id);
  const shop = s.shops[id];
  if (shop.owner === null) return 0;
  return feeFor(shopBaseFee(sq), sq.baseValue, shop.value, districtSize(s, sq.district), ownedInDistrict(s, sq.district, shop.owner));
}

/** How much more the owner may invest in this shop (0 if unowned). */
export function shopMaxCapital(s: GameState, id: SquareId): number {
  const sq = shopSquare(indexBoard(s.board), id);
  const shop = s.shops[id];
  if (shop.owner === null) return 0;
  return maxCapitalFor(sq.baseValue, shop.value, districtSize(s, sq.district), ownedInDistrict(s, sq.district, shop.owner));
}

export function stockPrice(s: GameState, d: DistrictId): number {
  const ids = indexBoard(s.board).districtShops.get(d) ?? [];
  const total = ids.reduce((sum, id) => sum + s.shops[id].value, 0);
  return priceFor(Math.floor(total / ids.length), s.stockMult[d]);
}

export function stockValue(s: GameState, p: PlayerId): number {
  const pl = s.players[p];
  return indexBoard(s.board).districts.reduce((sum, d) => sum + (pl.shares[d] ?? 0) * stockPrice(s, d), 0);
}

export function ownedShops(s: GameState, p: PlayerId): SquareId[] {
  return indexBoard(s.board).shops.filter((sq) => s.shops[sq.id].owner === p).map((sq) => sq.id);
}

export function shopsValue(s: GameState, p: PlayerId): number {
  return ownedShops(s, p).reduce((sum, id) => sum + s.shops[id].value, 0);
}

/** §1: cash + shops + stocks. */
export function netWorth(s: GameState, p: PlayerId): number {
  return s.players[p].cash + shopsValue(s, p) + stockValue(s, p);
}

/** §9: salary paid on promotion at the player's current level. */
export function salary(s: GameState, p: PlayerId): number {
  const c = s.config;
  return c.baseSalary + c.salaryIncrement * s.players[p].level + Math.floor((shopsValue(s, p) * c.shopBonusRate) / 100);
}

/** §5.5: may spend `cost` if cash + stock value covers it. */
export function canAfford(s: GameState, p: PlayerId, cost: number): boolean {
  return s.players[p].cash + stockValue(s, p) >= cost;
}

export function buyoutPrice(s: GameState, id: SquareId): number {
  return s.shops[id].value * s.config.buyoutMultiplier;
}

export function debtSalePrice(s: GameState, id: SquareId): number {
  return Math.floor((s.shops[id].value * s.config.debtSaleRate) / 100);
}

/** Best first. Bankrupt players last; ties go to the player later in turn order (§1). */
export function rankings(s: GameState): PlayerId[] {
  return s.players
    .map((_, i) => i)
    .sort((a, b) => Number(s.players[a].bankrupt) - Number(s.players[b].bankrupt) || netWorth(s, b) - netWorth(s, a) || b - a);
}
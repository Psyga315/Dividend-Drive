// A rule-of-thumb bot. It looks one move ahead and follows simple money rules;
// a Personality tunes how much it spends on stocks, shops and buyouts.
import {
  FEE_MULT_X4, MULT_ONE, SUITS, dividendShare, districtSize, indexBoard, netWorth, ownedInDistrict, ownedShops,
  salary, shopBaseFee, shopFee, stockValue,
  type ActionBody, type ActionPrompt, type BoardDef, type Choice, type DistrictId, type GameState, type PlayerId,
  type ShopSquare, type SquareId, type Suit,
} from '../engine/index.ts';
import type { Bot } from './bot.ts';

export interface Personality {
  /** Share of spare cash spent on stocks at each chance (0 = never buys stocks). */
  stockAppetite: number;
  /** Share of spare cash invested in shops at each chance. */
  investAppetite: number;
  /** Buy out rivals' shops to complete or nearly complete a district. */
  buyouts: boolean;
  /** Cash kept back = max(minReserve, reserveFactor × the biggest fee a rival charges). */
  minReserve: number;
  reserveFactor: number;
}

export const PERSONALITIES = {
  balanced: { stockAppetite: 0.4, investAppetite: 0.8, buyouts: true, minReserve: 150, reserveFactor: 0.6 },
  landlord: { stockAppetite: 0, investAppetite: 1, buyouts: true, minReserve: 150, reserveFactor: 0.6 },
  trader: { stockAppetite: 0.9, investAppetite: 0.3, buyouts: false, minReserve: 150, reserveFactor: 0.6 },
} satisfies Record<string, Personality>;

export function heuristicBot(name: string, personality: Personality): Bot {
  return { name, chooseAction: (state, prompt, rand) => decide(state, prompt, rand, personality) };
}

const PASS: ActionBody = { type: 'pass' };

function decide(s: GameState, prompt: ActionPrompt, rand: () => number, pers: Personality): ActionBody {
  const me = prompt.player;
  const ph = s.phase;
  switch (ph.kind) {
    case 'preRoll':
      return preRoll();
    case 'move': {
      const best = bestBy(pick(prompt, 'move'), (m) => scorePath(s, me, m.path, pers) + rand());
      return best ? { type: 'move', path: best.path } : PASS;
    }
    case 'buyShop': {
      const ch = pick(prompt, 'buyShop')[0];
      return ch && ch.price <= spare(s, me, pers) ? { type: 'buyShop' } : PASS;
    }
    case 'buyout': {
      const ch = pick(prompt, 'buyout')[0];
      return ch && wantsBuyout(s, me, ph.square, ch.price, pers) ? { type: 'buyout' } : PASS;
    }
    case 'invest':
      return invest(s, me, prompt, pers);
    case 'buyStock':
      return buyStock(s, me, prompt, rand, pers);
    case 'sellStockCard': {
      // Card: sell at +20%. Only cash in districts where we own no shops; our own districts are worth keeping.
      const options = pick(prompt, 'sellStock').filter((c) => ownedInDistrict(s, c.district, me) === 0);
      const best = bestBy(options, (c) => c.maxQty * c.pricePerShare);
      return best ? { type: 'sellStock', district: best.district, qty: best.maxQty } : PASS;
    }
    case 'chooseDistrict': {
      // Card: +20% stock price in a district of your choice.
      const best = bestBy(pick(prompt, 'chooseDistrict'), (c) => holdingEdge(s, me, c.district));
      return best ? { type: 'chooseDistrict', district: best.district } : PASS;
    }
    case 'debt':
      return payDebt(s, me, prompt);
    case 'auction':
      return bid(s, me, ph.square, prompt, rand, pers);
    case 'gameOver':
      return PASS;
  }
}

// ---------- Money sense ----------

/** Cash to keep on hand for the next fee. */
function reserveFor(s: GameState, me: PlayerId, pers: Personality): number {
  let biggestFee = 0;
  for (const sq of indexBoard(s.board).shops) {
    const owner = s.shops[sq.id].owner;
    if (owner !== null && owner !== me) biggestFee = Math.max(biggestFee, shopFee(s, sq.id));
  }
  return Math.max(pers.minReserve, Math.round(biggestFee * pers.reserveFactor));
}

/** Cash the bot is willing to spend. Stocks can be sold in a pinch, so they cover part of the reserve. */
function spare(s: GameState, me: PlayerId, pers: Personality): number {
  const stockCover = Math.floor(stockValue(s, me) / 2);
  return s.players[me].cash - Math.max(0, reserveFor(s, me, pers) - stockCover);
}

/** How many more shares can be sold in a district this turn without triggering the large-sale price drop. */
function sellRoom(s: GameState, me: PlayerId, d: DistrictId): number {
  return (s.turn.netTrades[me]?.[d] ?? 0) + s.config.largeTradeThreshold - 1;
}

/**
 * Always just rolls. Selling stock early isn't needed: the engine lets stocks back a purchase,
 * and payDebt() sells them at full price if a fee leaves us short.
 */
function preRoll(): ActionBody {
  return { type: 'roll' };
}

function wantsBuyout(s: GameState, me: PlayerId, id: SquareId, price: number, pers: Personality): boolean {
  if (!pers.buyouts) return false;
  const sq = shopDef(s, id);
  const size = districtSize(s, sq.district);
  const after = ownedInDistrict(s, sq.district, me) + 1;
  const strategic = after === size || (size >= 3 && after >= size - 1);
  return strategic && price <= spare(s, me, pers);
}

/** Investments smaller than this aren't worth a click. */
const MIN_INVEST = 20;

function invest(s: GameState, me: PlayerId, prompt: ActionPrompt, pers: Personality): ActionBody {
  const options = pick(prompt, 'invest').filter((c) => c.maxAmount >= MIN_INVEST);
  // Budget for the whole turn, so repeated prompts don't keep re-spending the remainder.
  const budget = Math.floor(pers.investAppetite * (spare(s, me, pers) + s.turn.invested)) - s.turn.invested;
  if (options.length === 0 || budget < MIN_INVEST) return PASS;
  const best = bestBy(options, (c) => investRate(s, me, c.square))!;
  return { type: 'invest', square: best.square, amount: Math.min(best.maxAmount, budget) };
}

/** Payoff per 1G invested: extra fee per visit, plus the rise in value of our own shares in that district. */
function investRate(s: GameState, me: PlayerId, id: SquareId): number {
  const sq = shopDef(s, id);
  const size = districtSize(s, sq.district);
  const feeMult = FEE_MULT_X4[size][ownedInDistrict(s, sq.district, me) - 1] / 4;
  const feeGain = (2 * shopBaseFee(sq) * feeMult) / sq.baseValue;
  const stockGain = (s.players[me].shares[sq.district] * s.stockMult[sq.district]) / MULT_ONE / size;
  return feeGain + stockGain;
}

function buyStock(s: GameState, me: PlayerId, prompt: ActionPrompt, rand: () => number, pers: Personality): ActionBody {
  const options = pick(prompt, 'buyStock');
  const room = spare(s, me, pers);
  const budget = Math.floor(room * pers.stockAppetite);
  if (options.length === 0 || budget <= 0) return PASS;
  const best = bestBy(options, (c) => districtOutlook(s, me, c.district) + rand() * 0.01)!;
  let qty = Math.floor(budget / best.pricePerShare);
  const bump = s.config.largeTradeThreshold;
  if (qty < bump && bump * best.pricePerShare <= room) qty = bump; // 10+ shares also lifts the price
  qty = Math.min(qty, best.maxQty);
  // Fewer shares than the dividend minimum aren't worth buying.
  return qty >= s.config.dividendMinShares ? { type: 'buyStock', district: best.district, qty } : PASS;
}

/** Prices rise when shops get investment, so prefer districts where shops are owned, ours most of all. */
function districtOutlook(s: GameState, me: PlayerId, d: DistrictId): number {
  const ids = indexBoard(s.board).districtShops.get(d) ?? [];
  let score = 0;
  for (const id of ids) {
    const owner = s.shops[id].owner;
    if (owner === me) score += 3;
    else if (owner !== null) score += 1;
  }
  return score / Math.max(1, ids.length);
}

/** How much a price rise in this district helps us compared with rivals. */
function holdingEdge(s: GameState, me: PlayerId, d: DistrictId): number {
  return s.players.reduce((sum, pl, i) => sum + (i === me ? 1 : -0.5) * pl.shares[d], 0);
}

function payDebt(s: GameState, me: PlayerId, prompt: ActionPrompt): ActionBody {
  const need = -s.players[me].cash;
  const sells = pick(prompt, 'sellStock');
  if (sells.length > 0) {
    // Stocks first (full price). Avoid the large-sale drop and our own districts where possible.
    const best = bestBy(sells, (c) =>
      (sellRoom(s, me, c.district) > 0 ? 1000 : 0) - 10 * ownedInDistrict(s, c.district, me) + (c.maxQty * c.pricePerShare) / 1e6,
    )!;
    let qty = Math.ceil(need / best.pricePerShare);
    const room = sellRoom(s, me, best.district);
    if (room > 0) qty = Math.min(qty, room);
    return { type: 'sellStock', district: best.district, qty: clamp(qty, 1, best.maxQty) };
  }
  // Then shops (75%): the cheapest one that covers the debt, from our weakest district.
  const shops = pick(prompt, 'sellShop');
  const covering = shops.filter((c) => c.bankPays >= need);
  const best = covering.length > 0
    ? bestBy(covering, (c) => -1e6 * ownedInDistrict(s, shopDef(s, c.square).district, me) - c.bankPays)
    : bestBy(shops, (c) => c.bankPays);
  return best ? { type: 'sellShop', square: best.square } : PASS;
}

function bid(s: GameState, me: PlayerId, id: SquareId, prompt: ActionPrompt, rand: () => number, pers: Personality): ActionBody {
  const ch = pick(prompt, 'bid')[0];
  if (!ch) return PASS;
  const mine = ownedInDistrict(s, shopDef(s, id).district, me);
  const worth = Math.floor(s.shops[id].value * (1 + 0.15 * mine) + rand() * 5);
  const amount = Math.min(worth, ch.max, spare(s, me, pers));
  return amount >= ch.min ? { type: 'bid', amount: Math.floor(amount) } : PASS;
}

// ---------- Movement ----------

function scorePath(s: GameState, me: PlayerId, path: SquareId[], pers: Personality): number {
  const b = indexBoard(s.board);
  const pl = s.players[me];
  const pay = salary(s, me);
  const suits = new Set<Suit>(pl.suits);
  let score = 0;
  for (const id of path) {
    const sq = b.byId.get(id)!;
    if (sq.type === 'suit' && !suits.has(sq.suit)) {
      suits.add(sq.suit);
      score += pay / 4;
    }
  }
  const missing = SUITS.filter((suit) => !suits.has(suit));
  const promotes = missing.length <= pl.wildcards;
  const worth = netWorth(s, me);
  const target = s.config.targetNetWorth;
  const end = path[path.length - 1];
  if (end === b.bank) {
    if (worth + (promotes ? pay : 0) >= target) return 1e9; // winning move
    return score + (promotes ? pay : 0) + 20;
  }
  score += landingValue(s, me, end, pers);
  // Looking further ahead: head for the bank once promotion (or the win) is ready, otherwise toward missing suits.
  const goals = promotes || worth >= target
    ? [b.bank]
    : s.board.squares.flatMap((sq) => (sq.type === 'suit' && missing.includes(sq.suit) ? [sq.id] : []));
  if (goals.length > 0) {
    const pull = worth >= target ? 500 : pay / 30;
    score -= pull * Math.min(...goals.map((g) => distance(s.board, end, g)));
  }
  return score;
}

function landingValue(s: GameState, me: PlayerId, id: SquareId, pers: Personality): number {
  const sq = indexBoard(s.board).byId.get(id)!;
  switch (sq.type) {
    case 'shop': {
      const shop = s.shops[id];
      if (shop.owner === null) return shop.value <= spare(s, me, pers) ? 60 + 40 * ownedInDistrict(s, sq.district, me) : 0;
      if (shop.owner === me) return spare(s, me, pers) > 50 ? 40 : 0;
      if (s.players[shop.owner].shopsClosed) return 0;
      const fee = shopFee(s, id);
      const pool = Math.floor((fee * s.config.dividendRate) / 100);
      const total = s.players.reduce((n, p) => n + p.shares[sq.district], 0);
      const back = total > 0 ? dividendShare(pool, s.players[me].shares[sq.district], total, s.config.dividendMinShares) : 0;
      const shortfall = Math.max(0, fee - s.players[me].cash); // forced sales lose money
      return -1.2 * (fee - back) - 0.3 * shortfall;
    }
    case 'stockbroker':
      return pers.stockAppetite > 0 && spare(s, me, pers) > 100 ? 25 : 0;
    case 'takeABreak':
      return -15 * ownedShops(s, me).length;
    case 'suit':
    case 'venture':
      return s.config.ventureCards ? 15 : 0;
    case 'bank':
      return 0;
  }
}

// ---------- Helpers ----------

type ChoiceOf<T extends Choice['type']> = Extract<Choice, { type: T }>;

function pick<T extends Choice['type']>(prompt: ActionPrompt, type: T): ChoiceOf<T>[] {
  return prompt.choices.filter((c): c is ChoiceOf<T> => c.type === type);
}

function bestBy<T>(items: T[], score: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const item of items) {
    const v = score(item);
    if (v > bestScore) {
      best = item;
      bestScore = v;
    }
  }
  return best;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function shopDef(s: GameState, id: SquareId): ShopSquare {
  const sq = indexBoard(s.board).byId.get(id);
  if (!sq || sq.type !== 'shop') throw new Error(`Square ${id} is not a shop`);
  return sq;
}

/** Squares apart, ignoring the no-U-turn rule (good enough for planning). Cached per board. */
const distanceCache = new WeakMap<BoardDef, Map<SquareId, Map<SquareId, number>>>();

function distance(board: BoardDef, from: SquareId, to: SquareId): number {
  let all = distanceCache.get(board);
  if (!all) {
    all = new Map();
    const byId = indexBoard(board).byId;
    for (const start of board.squares) {
      const dist = new Map<SquareId, number>([[start.id, 0]]);
      const queue = [start.id];
      for (let i = 0; i < queue.length; i++) {
        for (const next of byId.get(queue[i])!.links) {
          if (!dist.has(next)) {
            dist.set(next, dist.get(queue[i])! + 1);
            queue.push(next);
          }
        }
      }
      all.set(start.id, dist);
    }
    distanceCache.set(board, all);
  }
  return all.get(from)?.get(to) ?? 99;
}
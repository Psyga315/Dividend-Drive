// The rules engine. Entry points: createGame(), legalActions(), step().
// step() never changes the state you pass in; it returns a new state plus a list of events.
import type {
  Action, ActionPrompt, BoardDef, Choice, Config, DistrictId, GameEndReason, GameEvent,
  GameState, PlayerId, ShopSquare, SquareDef, SquareId, StepResult, Suit, TurnState,
} from './types.ts';
import { DEFAULT_CONFIG } from './config.ts';
import { type BoardIndex, enumeratePaths, indexBoard, square, validateBoard } from './board.ts';
import {
  SUITS, adjustPct, buyoutPrice, canAfford, debtSalePrice, districtSize, dividendShare, netWorth,
  ownedInDistrict, ownedShops, rankings, salary, shopFee, shopMaxCapital, stockPrice, stockValue,
} from './economy.ts';
import { randInt, shuffle } from './rng.ts';
import { VENTURE_CARD_IDS, VENTURE_CARDS } from './ventures.ts';

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}

/** Working context while applying one action. */
interface Ctx {
  s: GameState; // a private copy, safe to change
  b: BoardIndex;
  ev: GameEvent[];
}

const PASS: Choice = { type: 'pass' };

// =====================================================================
// Public API
// =====================================================================

export interface NewGameOptions {
  board: BoardDef;
  players: string[]; // names, 2-4
  config?: Partial<Config>;
  seed?: number;
}

export function createGame(opts: NewGameOptions): GameState {
  const problems = validateBoard(opts.board);
  if (problems.length > 0) throw new Error('Invalid board:\n' + problems.join('\n'));
  if (opts.players.length < 2 || opts.players.length > 4) throw new Error('A game needs 2-4 players.');
  const config: Config = { ...DEFAULT_CONFIG, ...opts.config };
  const b = indexBoard(opts.board);
  const s: GameState = {
    config,
    board: opts.board,
    players: [],
    shops: {},
    stockMult: {},
    phase: { kind: 'preRoll' },
    turn: newTurn(0),
    round: 1,
    turnNumber: 1,
    rng: (opts.seed ?? Math.floor(Math.random() * 0x100000000)) | 0,
    deck: [],
  };
  const names = [...opts.players];
  if (config.randomTurnOrder) shuffle(s, names);
  s.players = names.map((name, i) => ({
    name,
    cash: config.initialCash + config.seatCashBonus * i, // later seats get catch-up cash (§19)
    level: 1,
    suits: [],
    wildcards: 0,
    shares: Object.fromEntries(b.districts.map((d) => [d, 0])),
    position: b.bank,
    cameFrom: null,
    freeDirection: false,
    shopsClosed: false,
    bankrupt: false,
  }));
  for (const sq of b.shops) s.shops[sq.id] = { value: sq.baseValue, owner: null };
  for (const d of b.districts) s.stockMult[d] = config.stockMultStart;
  if (config.ventureCards) s.deck = freshDeck(s);
  return s;
}

/** Who must act now, or null when the game is over. */
export function currentPlayer(s: GameState): PlayerId | null {
  return legalActions(s)?.player ?? null;
}

/** Everything the acting player may do now. Amounts are given as ranges. */
export function legalActions(s: GameState): ActionPrompt | null {
  const b = indexBoard(s.board);
  const ph = s.phase;
  const me = s.turn.player;
  const pl = s.players[me];
  switch (ph.kind) {
    case 'preRoll':
      return { player: me, choices: [{ type: 'roll' }, ...sellChoices(s, me, 0)] };
    case 'move':
      return {
        player: me,
        choices: enumeratePaths(b, pl.position, pl.cameFrom, ph.remaining).map((path): Choice => ({ type: 'move', path })),
      };
    case 'buyShop':
      return { player: me, choices: [{ type: 'buyShop', price: s.shops[ph.square].value }, PASS] };
    case 'buyout':
      return { player: me, choices: [{ type: 'buyout', price: buyoutPrice(s, ph.square) }, PASS] };
    case 'invest':
      return { player: me, choices: [...investChoices(s, me), PASS] };
    case 'buyStock':
      return { player: me, choices: [...buyChoices(s, me, ph.discountPct), PASS] };
    case 'sellStockCard':
      return { player: me, choices: [...sellChoices(s, me, ph.premiumPct), PASS] };
    case 'chooseDistrict':
      return { player: me, choices: b.districts.map((district): Choice => ({ type: 'chooseDistrict', district })) };
    case 'debt':
      return { player: ph.player, choices: debtChoices(s, ph.player) };
    case 'auction': {
      const bidder = ph.bidders[ph.bids.indexOf(null)];
      return { player: bidder, choices: [{ type: 'bid', min: s.shops[ph.square].value, max: s.players[bidder].cash }, PASS] };
    }
    case 'gameOver':
      return null;
  }
}

/** Apply one action. Throws IllegalActionError if it isn't allowed right now. */
export function step(state: GameState, action: Action): StepResult {
  const prompt = legalActions(state);
  if (!prompt) throw new IllegalActionError('The game is over.');
  if (action.player !== prompt.player) {
    throw new IllegalActionError(`Waiting for player ${prompt.player}, got an action from player ${action.player}.`);
  }
  if (!isAllowed(prompt.choices, action)) {
    throw new IllegalActionError(`Not allowed during "${state.phase.kind}": ${JSON.stringify(action)}`);
  }
  const s = cloneState(state);
  const c: Ctx = { s, b: indexBoard(s.board), ev: [] };
  apply(c, action);
  return { state: s, events: c.ev };
}

// =====================================================================
// Choices and validation
// =====================================================================

function sellChoices(s: GameState, p: PlayerId, premiumPct: number): Choice[] {
  const pl = s.players[p];
  return indexBoard(s.board)
    .districts.filter((d) => pl.shares[d] > 0)
    .map((d): Choice => ({ type: 'sellStock', district: d, maxQty: pl.shares[d], pricePerShare: adjustPct(stockPrice(s, d), premiumPct) }));
}

function buyChoices(s: GameState, p: PlayerId, discountPct: number): Choice[] {
  const cash = Math.max(0, s.players[p].cash);
  const out: Choice[] = [];
  for (const d of indexBoard(s.board).districts) {
    const pricePerShare = Math.max(1, adjustPct(stockPrice(s, d), -discountPct));
    const maxQty = Math.min(s.config.maxSharesPerPurchase, Math.floor(cash / pricePerShare));
    if (maxQty >= 1) out.push({ type: 'buyStock', district: d, maxQty, pricePerShare });
  }
  return out;
}

function investChoices(s: GameState, p: PlayerId): Choice[] {
  const room = s.config.maxInvestPerTurn - s.turn.invested;
  const funds = s.players[p].cash + stockValue(s, p); // §5.5: stocks count as backup
  const out: Choice[] = [];
  for (const id of ownedShops(s, p)) {
    const maxAmount = Math.min(shopMaxCapital(s, id), room, funds);
    if (maxAmount >= 1) out.push({ type: 'invest', square: id, maxAmount });
  }
  return out;
}

function debtChoices(s: GameState, p: PlayerId): Choice[] {
  return [
    ...sellChoices(s, p, 0),
    ...ownedShops(s, p).map((id): Choice => ({ type: 'sellShop', square: id, bankPays: debtSalePrice(s, id) })),
  ];
}

function isAllowed(choices: Choice[], a: Action): boolean {
  const whole = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  return choices.some((ch) => {
    switch (ch.type) {
      case 'move':
        return a.type === 'move' && Array.isArray(a.path) && a.path.length === ch.path.length && a.path.every((id, i) => id === ch.path[i]);
      case 'sellStock':
        return a.type === 'sellStock' && a.district === ch.district && whole(a.qty, 1, ch.maxQty);
      case 'buyStock':
        return a.type === 'buyStock' && a.district === ch.district && whole(a.qty, 1, ch.maxQty);
      case 'invest':
        return a.type === 'invest' && a.square === ch.square && whole(a.amount, 1, ch.maxAmount);
      case 'chooseDistrict':
        return a.type === 'chooseDistrict' && a.district === ch.district;
      case 'sellShop':
        return a.type === 'sellShop' && a.square === ch.square;
      case 'bid':
        return a.type === 'bid' && whole(a.amount, ch.min, ch.max);
      default:
        return a.type === ch.type;
    }
  });
}

// =====================================================================
// Applying actions
// =====================================================================

function apply(c: Ctx, a: Action): void {
  const { s } = c;
  const ph = s.phase;
  const p = a.player;
  switch (a.type) {
    case 'roll': {
      const value = 1 + randInt(s, s.config.dieMax);
      s.turn.roll = value;
      c.ev.push({ type: 'rolled', player: p, value });
      s.phase = { kind: 'move', remaining: value };
      return;
    }
    case 'move':
      if (ph.kind !== 'move') break;
      return move(c, p, a.path, ph.remaining);
    case 'sellStock':
      sellStock(c, p, a.district, a.qty, ph.kind === 'sellStockCard' ? ph.premiumPct : 0);
      if (ph.kind !== 'preRoll') finishTurn(c); // debt: check debts again; card: turn is over
      return;
    case 'buyStock':
      if (ph.kind !== 'buyStock') break;
      buyStock(c, p, a.district, a.qty, ph.discountPct);
      return afterStockStop(c, ph.remaining);
    case 'buyShop': {
      if (ph.kind !== 'buyShop') break;
      const price = s.shops[ph.square].value;
      s.players[p].cash -= price;
      s.shops[ph.square].owner = p;
      c.ev.push({ type: 'shopBought', player: p, square: ph.square, price });
      return finishTurn(c);
    }
    case 'buyout': {
      if (ph.kind !== 'buyout') break;
      const shop = s.shops[ph.square];
      const from = shop.owner!;
      const price = buyoutPrice(s, ph.square);
      const ownerReceived = shop.value * s.config.buyoutToOwner;
      s.players[p].cash -= price;
      s.players[from].cash += ownerReceived;
      shop.owner = p;
      c.ev.push({ type: 'boughtOut', player: p, from, square: ph.square, price, ownerReceived });
      return finishTurn(c);
    }
    case 'invest':
      s.players[p].cash -= a.amount;
      s.shops[a.square].value += a.amount;
      s.turn.invested += a.amount;
      c.ev.push({ type: 'invested', player: p, square: a.square, amount: a.amount });
      if (investChoices(s, p).length === 0) finishTurn(c);
      return;
    case 'chooseDistrict': // only venture card 5 uses this
      changeStockMult(c, a.district, 20, 'card');
      return finishTurn(c);
    case 'sellShop':
      return sellShopForDebt(c, p, a.square);
    case 'bid':
    case 'pass':
      if (ph.kind === 'auction') return recordBid(c, a.type === 'bid' ? a.amount : 0);
      if (ph.kind === 'buyStock') return afterStockStop(c, ph.remaining);
      return finishTurn(c); // declining buyShop / buyout / invest / sellStockCard
  }
  throw new Error(`Engine bug: "${a.type}" reached apply() during "${ph.kind}"`);
}

function move(c: Ctx, p: PlayerId, path: SquareId[], remainingBefore: number): void {
  const { s, b } = c;
  const pl = s.players[p];
  const from = pl.position;
  c.ev.push({ type: 'moved', player: p, from, path: [...path] });
  path.forEach((id, i) => {
    const sq = square(b, id);
    if (sq.type === 'suit') collectSuit(c, p, sq.suit, i < path.length - 1); // passing or landing
  });
  pl.cameFrom = path.length >= 2 ? path[path.length - 2] : from;
  pl.position = path[path.length - 1];
  const remaining = remainingBefore - path.length;
  const end = square(b, pl.position);
  if (end.type === 'bank') return arriveAtBank(c, p, remaining);
  return land(c, p, end);
}

function collectSuit(c: Ctx, p: PlayerId, suit: Suit, onTheWay: boolean): void {
  const pl = c.s.players[p];
  if (pl.suits.includes(suit)) return;
  pl.suits.push(suit);
  c.ev.push({ type: 'suitCollected', player: p, suit, onTheWay });
}

/** §9: promotion, then win check, then stock buying. `remaining` > 0 means just passing. */
function arriveAtBank(c: Ctx, p: PlayerId, remaining: number): void {
  const { s } = c;
  const pl = s.players[p];
  const missing = SUITS.filter((suit) => !pl.suits.includes(suit)).length;
  if (missing <= pl.wildcards) {
    const amount = salary(s, p);
    pl.cash += amount;
    pl.level += 1;
    pl.suits = [];
    pl.wildcards -= missing;
    c.ev.push({ type: 'promoted', player: p, level: pl.level, salary: amount });
  }
  if (netWorth(s, p) >= s.config.targetNetWorth) return endGame(c, p, 'target');
  offerStocks(c, p, 0, remaining);
}

function land(c: Ctx, p: PlayerId, sq: SquareDef): void {
  const { s } = c;
  switch (sq.type) {
    case 'shop':
      return landOnShop(c, p, sq);
    case 'suit':
    case 'venture':
      return s.config.ventureCards ? drawCard(c, p) : finishTurn(c);
    case 'stockbroker':
      return offerStocks(c, p, 0, 0);
    case 'takeABreak':
      s.players[p].shopsClosed = true;
      c.ev.push({ type: 'tookBreak', player: p });
      return finishTurn(c);
    case 'bank':
      return arriveAtBank(c, p, 0);
  }
}

function landOnShop(c: Ctx, p: PlayerId, sq: ShopSquare): void {
  const { s } = c;
  const shop = s.shops[sq.id];
  if (shop.owner === null) {
    if (canAfford(s, p, shop.value)) s.phase = { kind: 'buyShop', square: sq.id };
    else finishTurn(c);
    return;
  }
  if (shop.owner === p) {
    if (investChoices(s, p).length > 0) s.phase = { kind: 'invest' };
    else finishTurn(c);
    return;
  }
  const owner = shop.owner;
  if (s.players[owner].shopsClosed) {
    c.ev.push({ type: 'shopClosed', square: sq.id, owner });
  } else {
    const fee = shopFee(s, sq.id);
    s.players[p].cash -= fee;
    s.players[owner].cash += fee;
    c.ev.push({ type: 'feePaid', player: p, owner, square: sq.id, amount: fee });
    payDividends(c, sq.district, fee);
  }
  if (canBuyout(s, p, sq)) s.phase = { kind: 'buyout', square: sq.id };
  else finishTurn(c);
}

function canBuyout(s: GameState, p: PlayerId, sq: ShopSquare): boolean {
  const owner = s.shops[sq.id].owner!;
  if (s.config.protectDominatedShops && ownedInDistrict(s, sq.district, owner) === districtSize(s, sq.district)) return false;
  return canAfford(s, p, buyoutPrice(s, sq.id));
}

/** §8.4: the bank adds a pool worth 20% of the fee, split among shareholders. */
function payDividends(c: Ctx, d: DistrictId, fee: number): void {
  const { s } = c;
  const pool = Math.floor((fee * s.config.dividendRate) / 100);
  const total = s.players.reduce((sum, pl) => sum + pl.shares[d], 0);
  if (pool <= 0 || total === 0) return;
  s.players.forEach((pl, i) => {
    if (pl.shares[d] === 0) return;
    const amount = dividendShare(pool, pl.shares[d], total, s.config.dividendMinShares);
    if (amount === 0) return;
    pl.cash += amount;
    c.ev.push({ type: 'dividend', player: i, district: d, amount });
  });
}

// ---------- Stocks ----------

function offerStocks(c: Ctx, p: PlayerId, discountPct: number, remaining: number): void {
  if (buyChoices(c.s, p, discountPct).length > 0) c.s.phase = { kind: 'buyStock', discountPct, remaining };
  else afterStockStop(c, remaining);
}

/** After a stock stop: keep moving if this was a bank pass, otherwise end the turn. */
function afterStockStop(c: Ctx, remaining: number): void {
  if (remaining > 0) c.s.phase = { kind: 'move', remaining };
  else finishTurn(c);
}

function addTrade(s: GameState, p: PlayerId, d: DistrictId, qty: number): void {
  const byDistrict = (s.turn.netTrades[p] ??= {});
  byDistrict[d] = (byDistrict[d] ?? 0) + qty;
}

function buyStock(c: Ctx, p: PlayerId, d: DistrictId, qty: number, discountPct: number): void {
  const pricePerShare = Math.max(1, adjustPct(stockPrice(c.s, d), -discountPct));
  const pl = c.s.players[p];
  pl.cash -= pricePerShare * qty;
  pl.shares[d] += qty;
  addTrade(c.s, p, d, qty);
  c.ev.push({ type: 'stockBought', player: p, district: d, qty, pricePerShare });
}

function sellStock(c: Ctx, p: PlayerId, d: DistrictId, qty: number, premiumPct: number): void {
  const pricePerShare = adjustPct(stockPrice(c.s, d), premiumPct);
  const pl = c.s.players[p];
  pl.cash += pricePerShare * qty;
  pl.shares[d] -= qty;
  addTrade(c.s, p, d, -qty);
  c.ev.push({ type: 'stockSold', player: p, district: d, qty, pricePerShare });
}

function changeStockMult(c: Ctx, d: DistrictId, pct: number, reason: 'largeBuy' | 'largeSell' | 'card'): void {
  const { s } = c;
  const oldPrice = stockPrice(s, d);
  s.stockMult[d] = Math.max(1, Math.round((s.stockMult[d] * (100 + pct)) / 100));
  c.ev.push({ type: 'stockPriceChanged', district: d, oldPrice, newPrice: stockPrice(s, d), reason });
}

/** §8.3: one price step per player per district per turn, however big the trade. */
function applyLargeTrades(c: Ctx): void {
  const { largeTradeThreshold: threshold, largeTradeStep: pct } = c.s.config;
  for (const byDistrict of Object.values(c.s.turn.netTrades)) {
    for (const [d, net] of Object.entries(byDistrict)) {
      if (net >= threshold) changeStockMult(c, d, pct, 'largeBuy');
      else if (net <= -threshold) changeStockMult(c, d, -pct, 'largeSell');
    }
  }
  c.s.turn.netTrades = {};
}

// ---------- Debt, auctions, bankruptcy (§10) ----------

function sellShopForDebt(c: Ctx, p: PlayerId, id: SquareId): void {
  const { s } = c;
  const amount = debtSalePrice(s, id);
  s.players[p].cash += amount;
  s.shops[id].owner = null;
  c.ev.push({ type: 'shopSoldToBank', player: p, square: id, amount });
  const minBid = s.shops[id].value;
  const bidders = s.players.map((_, i) => i).filter((i) => i !== p && !s.players[i].bankrupt);
  const bids = bidders.map((i) => (s.players[i].cash >= minBid ? null : 0)); // can't afford = automatic pass
  s.phase = { kind: 'auction', square: id, seller: p, bidders, bids };
  if (!bids.includes(null)) resolveAuction(c);
}

function recordBid(c: Ctx, amount: number): void {
  const ph = c.s.phase;
  if (ph.kind !== 'auction') throw new Error('Engine bug: no auction running');
  ph.bids[ph.bids.indexOf(null)] = amount;
  if (!ph.bids.includes(null)) resolveAuction(c);
}

function resolveAuction(c: Ctx): void {
  const { s } = c;
  const ph = s.phase;
  if (ph.kind !== 'auction') throw new Error('Engine bug: no auction running');
  let winner = -1;
  let best = 0;
  for (let i = 0; i < ph.bidders.length; i++) {
    const bid = ph.bids[i] ?? 0;
    // >= so ties go to the player later in turn order (bidders are listed in turn order)
    if (bid > 0 && bid >= best) {
      best = bid;
      winner = ph.bidders[i];
    }
  }
  if (winner < 0) {
    c.ev.push({ type: 'auctionNoBids', square: ph.square });
  } else {
    s.players[winner].cash -= best; // the winning bid goes to the bank
    s.shops[ph.square].owner = winner;
    c.ev.push({ type: 'auctionWon', player: winner, square: ph.square, bid: best });
  }
  finishTurn(c);
}

function goBankrupt(c: Ctx, p: PlayerId): void {
  const pl = c.s.players[p];
  pl.bankrupt = true;
  for (const id of ownedShops(c.s, p)) c.s.shops[id].owner = null;
  for (const d of Object.keys(pl.shares)) pl.shares[d] = 0;
  c.ev.push({ type: 'bankrupt', player: p });
}

// ---------- End of turn (§4 step 5) ----------

/**
 * Called whenever the active player's turn has nothing left to decide.
 * Safe to call again after each debt payment: it stops at the first player who still owes money.
 */
function finishTurn(c: Ctx): void {
  const { s } = c;
  const n = s.players.length;
  for (let k = 0; k < n; k++) {
    const p = (s.turn.player + k) % n; // active player first, then turn order
    const pl = s.players[p];
    if (pl.bankrupt || pl.cash >= 0) continue;
    if (debtChoices(s, p).length > 0) {
      s.phase = { kind: 'debt', player: p };
      return;
    }
    goBankrupt(c, p);
  }
  applyLargeTrades(c);
  const alive = s.players.filter((pl) => !pl.bankrupt).length;
  if (n - alive >= s.config.bankruptcyLimit || alive <= 1) return endGame(c, rankings(s)[0], 'bankruptcy');
  nextTurn(c);
}

function nextTurn(c: Ctx): void {
  const { s } = c;
  const n = s.players.length;
  let p = s.turn.player;
  let newRound = false;
  do {
    p = (p + 1) % n;
    if (p === 0) newRound = true;
  } while (s.players[p].bankrupt);
  if (newRound) {
    if (s.config.maxRounds !== null && s.round >= s.config.maxRounds) return endGame(c, rankings(s)[0], 'maxRounds');
    s.round += 1;
  }
  s.turnNumber += 1;
  s.turn = newTurn(p);
  const pl = s.players[p];
  pl.shopsClosed = false;
  if (pl.position === c.b.bank || pl.freeDirection) {
    pl.cameFrom = null;
    pl.freeDirection = false;
  }
  s.phase = { kind: 'preRoll' };
  c.ev.push({ type: 'turnStarted', player: p, round: s.round });
}

function endGame(c: Ctx, winner: PlayerId, reason: GameEndReason): void {
  c.s.phase = { kind: 'gameOver', winner, reason };
  c.ev.push({ type: 'gameOver', winner, reason });
}

// ---------- Venture cards (§12, optional) ----------

function freshDeck(s: GameState): number[] {
  return shuffle(s, [...VENTURE_CARD_IDS]);
}

function drawCard(c: Ctx, p: PlayerId): void {
  const { s } = c;
  if (s.deck.length === 0) s.deck = freshDeck(s);
  const card = s.deck.pop()!;
  c.ev.push({ type: 'cardDrawn', player: p, card, text: VENTURE_CARDS[card] });
  applyCard(c, p, card);
}

function applyCard(c: Ctx, p: PlayerId, card: number): void {
  const { s, b } = c;
  const pl = s.players[p];
  const randomDistrict = () => b.districts[randInt(s, b.districts.length)];
  const gainCash = (amount: number) => {
    if (amount === 0) return;
    pl.cash += amount;
    c.ev.push({ type: 'cashChanged', player: p, amount });
  };
  const grantShares = (d: DistrictId, qty: number) => {
    pl.shares[d] += qty; // free shares don't count as large trades
    c.ev.push({ type: 'sharesGranted', player: p, district: d, qty });
  };
  switch (card) {
    case 1: changeStockMult(c, randomDistrict(), 10, 'card'); break;
    case 2: changeStockMult(c, randomDistrict(), 20, 'card'); break;
    case 3: changeStockMult(c, randomDistrict(), -10, 'card'); break;
    case 4: changeStockMult(c, randomDistrict(), -20, 'card'); break;
    case 5: s.phase = { kind: 'chooseDistrict', card }; return;
    case 6: grantShares(randomDistrict(), 20); break;
    case 7: for (const d of b.districts) grantShares(d, 5); break;
    case 8: gainCash(Math.floor(stockValue(s, p) / 10)); break;
    case 9: return offerStocks(c, p, 0, 0);
    case 10: return offerStocks(c, p, 10, 0);
    case 11:
      if (sellChoices(s, p, 20).length > 0) {
        s.phase = { kind: 'sellStockCard', premiumPct: 20 };
        return;
      }
      break;
    case 12: gainCash(-2 * Object.values(pl.shares).reduce((sum, n) => sum + n, 0)); break;
    case 13: changeShopValues(c, randomDistrict(), 10); break;
    case 14: changeShopValues(c, randomDistrict(), -10); break;
    case 15:
      if (investChoices(s, p).length > 0) {
        s.phase = { kind: 'invest' };
        return;
      }
      break;
    case 16: gainCash(50 * (1 + randInt(s, s.config.dieMax))); break;
    case 17: gainCash(-Math.floor(Math.max(0, pl.cash) / 10)); break;
    case 18:
      if (pl.wildcards < s.config.maxSuitYourself) {
        pl.wildcards += 1;
        c.ev.push({ type: 'wildcardGained', player: p });
      } else gainCash(100);
      break;
    case 19: pl.freeDirection = true; break;
    case 20: gainCash(Math.floor(salary(s, p) / 2)); break;
    default: throw new Error(`Unknown venture card ${card}`);
  }
  finishTurn(c);
}

function changeShopValues(c: Ctx, d: DistrictId, pct: number): void {
  for (const id of c.b.districtShops.get(d) ?? []) {
    const shop = c.s.shops[id];
    shop.value = Math.max(1, adjustPct(shop.value, pct));
  }
  c.ev.push({ type: 'shopValuesChanged', district: d, pct });
}

// ---------- Helpers ----------

function newTurn(player: PlayerId): TurnState {
  return { player, roll: null, invested: 0, netTrades: {} };
}

/**
 * Deep copy, except the board and config, which never change during a game.
 * Hand-written because structuredClone was most of the run time. If you add a nested
 * field to GameState, copy it here too (the fuzz test should catch it if you forget).
 */
function cloneState(s: GameState): GameState {
  const ph = s.phase;
  const shops: GameState['shops'] = {};
  for (const sq of indexBoard(s.board).shops) shops[sq.id] = { ...s.shops[sq.id] };
  const netTrades: TurnState['netTrades'] = {};
  for (const p of Object.keys(s.turn.netTrades).map(Number)) netTrades[p] = { ...s.turn.netTrades[p] };
  return {
    ...s,
    players: s.players.map((pl) => ({ ...pl, suits: [...pl.suits], shares: { ...pl.shares } })),
    shops,
    stockMult: { ...s.stockMult },
    phase: ph.kind === 'auction' ? { ...ph, bidders: [...ph.bidders], bids: [...ph.bids] } : { ...ph },
    turn: { ...s.turn, netTrades },
    deck: [...s.deck],
  };
}
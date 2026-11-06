// All shared types for the rules engine. No logic lives here.

export type Suit = 'spade' | 'heart' | 'diamond' | 'club';
export type SquareId = number;
export type PlayerId = number; // index into GameState.players (= turn order)
export type DistrictId = string;

// ---------- Board (static data, never changes during a game) ----------

interface SquareBase {
  id: SquareId;
  x: number;
  y: number;
  links: SquareId[];
}
export interface BankSquare extends SquareBase {
  type: 'bank';
}
export interface ShopSquare extends SquareBase {
  type: 'shop';
  district: DistrictId;
  baseValue: number;
  baseFee?: number; // if omitted, calculated with the formula in RULES.md §5.1
  name?: string;
}
export interface SuitSquare extends SquareBase {
  type: 'suit';
  suit: Suit;
}
export interface PlainSquare extends SquareBase {
  type: 'stockbroker' | 'takeABreak' | 'venture';
}
export type SquareDef = BankSquare | ShopSquare | SuitSquare | PlainSquare;

export interface BoardDef {
  name: string;
  squares: SquareDef[];
}

// ---------- Settings (RULES.md §2). Percentages are whole numbers: 10 = 10%. ----------

export interface Config {
  initialCash: number;
  seatCashBonus: number; // extra starting cash per later seat: player i gets initialCash + i × this
  targetNetWorth: number;
  baseSalary: number;
  salaryIncrement: number;
  shopBonusRate: number; // percent
  dieMax: number;
  maxInvestPerTurn: number;
  maxSharesPerPurchase: number;
  buyoutMultiplier: number;
  buyoutToOwner: number;
  debtSaleRate: number; // percent
  stockMultStart: number; // in 1/65536 units (2816 = 11/256)
  largeTradeThreshold: number;
  largeTradeStep: number; // percent
  dividendRate: number; // percent
  dividendMinShares: number;
  maxSuitYourself: number;
  bankruptcyLimit: number;
  maxRounds: number | null;
  protectDominatedShops: boolean;
  ventureCards: boolean;
  randomTurnOrder: boolean;
}

// ---------- Game state (everything here is plain JSON-safe data) ----------

export interface PlayerState {
  name: string;
  cash: number;
  level: number;
  suits: Suit[];
  wildcards: number; // Suit Yourself cards held
  shares: Record<DistrictId, number>;
  position: SquareId;
  cameFrom: SquareId | null; // null = may move in any direction
  freeDirection: boolean; // from venture card 19; used at the start of the next turn
  shopsClosed: boolean; // landed on take-a-break; reopens at the start of their next turn
  bankrupt: boolean;
}

export interface ShopState {
  value: number;
  owner: PlayerId | null;
}

export type GameEndReason = 'target' | 'bankruptcy' | 'maxRounds';

/** What the game is waiting for. */
export type Phase =
  | { kind: 'preRoll' }
  | { kind: 'move'; remaining: number }
  | { kind: 'buyShop'; square: SquareId }
  | { kind: 'buyout'; square: SquareId }
  | { kind: 'invest' }
  | { kind: 'buyStock'; discountPct: number; remaining: number } // remaining > 0 = paused at the bank mid-move
  | { kind: 'sellStockCard'; premiumPct: number }
  | { kind: 'chooseDistrict'; card: number }
  | { kind: 'debt'; player: PlayerId }
  | {
      kind: 'auction';
      square: SquareId;
      seller: PlayerId;
      bidders: PlayerId[];
      bids: (number | null)[]; // null = not bid yet, 0 = passed. Sealed: the UI must hide these.
    }
  | { kind: 'gameOver'; winner: PlayerId; reason: GameEndReason };

export interface TurnState {
  player: PlayerId;
  roll: number | null;
  invested: number; // toward maxInvestPerTurn
  netTrades: Record<PlayerId, Record<DistrictId, number>>; // shares bought minus sold this turn (§8.3)
}

export interface GameState {
  config: Config;
  board: BoardDef;
  players: PlayerState[];
  shops: Record<SquareId, ShopState>;
  stockMult: Record<DistrictId, number>; // 1/65536 units
  phase: Phase;
  turn: TurnState;
  round: number;
  turnNumber: number;
  rng: number; // seeded random number generator state
  deck: number[]; // venture card ids left to draw (draw from the end)
}

// ---------- Actions (what a player sends to step()) ----------

export type ActionBody =
  | { type: 'roll' }
  | { type: 'move'; path: SquareId[] }
  | { type: 'sellStock'; district: DistrictId; qty: number }
  | { type: 'buyStock'; district: DistrictId; qty: number }
  | { type: 'buyShop' }
  | { type: 'buyout' }
  | { type: 'invest'; square: SquareId; amount: number }
  | { type: 'chooseDistrict'; district: DistrictId }
  | { type: 'sellShop'; square: SquareId }
  | { type: 'bid'; amount: number }
  | { type: 'pass' }; // decline / done (skip buying, stop investing, pass in an auction...)

export type Action = ActionBody & { player: PlayerId };

// ---------- Choices (what legalActions() offers; amounts are ranges) ----------

export type Choice =
  | { type: 'roll' }
  | { type: 'move'; path: SquareId[] }
  | { type: 'sellStock'; district: DistrictId; maxQty: number; pricePerShare: number }
  | { type: 'buyStock'; district: DistrictId; maxQty: number; pricePerShare: number }
  | { type: 'buyShop'; price: number }
  | { type: 'buyout'; price: number }
  | { type: 'invest'; square: SquareId; maxAmount: number }
  | { type: 'chooseDistrict'; district: DistrictId }
  | { type: 'sellShop'; square: SquareId; bankPays: number }
  | { type: 'bid'; min: number; max: number }
  | { type: 'pass' };

export interface ActionPrompt {
  player: PlayerId; // who must act now
  choices: Choice[];
}

// ---------- Events (what happened, for the UI and logs) ----------

export type GameEvent =
  | { type: 'turnStarted'; player: PlayerId; round: number }
  | { type: 'rolled'; player: PlayerId; value: number }
  | { type: 'moved'; player: PlayerId; from: SquareId; path: SquareId[] }
  | { type: 'suitCollected'; player: PlayerId; suit: Suit; onTheWay: boolean } // onTheWay = passed it, didn't land on it
  | { type: 'promoted'; player: PlayerId; level: number; salary: number }
  | { type: 'feePaid'; player: PlayerId; owner: PlayerId; square: SquareId; amount: number }
  | { type: 'shopClosed'; square: SquareId; owner: PlayerId }
  | { type: 'dividend'; player: PlayerId; district: DistrictId; amount: number }
  | { type: 'shopBought'; player: PlayerId; square: SquareId; price: number }
  | { type: 'invested'; player: PlayerId; square: SquareId; amount: number }
  | { type: 'boughtOut'; player: PlayerId; from: PlayerId; square: SquareId; price: number; ownerReceived: number }
  | { type: 'stockBought'; player: PlayerId; district: DistrictId; qty: number; pricePerShare: number }
  | { type: 'stockSold'; player: PlayerId; district: DistrictId; qty: number; pricePerShare: number }
  | { type: 'stockPriceChanged'; district: DistrictId; oldPrice: number; newPrice: number; reason: 'largeBuy' | 'largeSell' | 'card' }
  | { type: 'tookBreak'; player: PlayerId }
  | { type: 'cardDrawn'; player: PlayerId; card: number; text: string }
  | { type: 'cashChanged'; player: PlayerId; amount: number }
  | { type: 'sharesGranted'; player: PlayerId; district: DistrictId; qty: number }
  | { type: 'shopValuesChanged'; district: DistrictId; pct: number }
  | { type: 'wildcardGained'; player: PlayerId }
  | { type: 'shopSoldToBank'; player: PlayerId; square: SquareId; amount: number }
  | { type: 'auctionWon'; player: PlayerId; square: SquareId; bid: number }
  | { type: 'auctionNoBids'; square: SquareId }
  | { type: 'bankrupt'; player: PlayerId }
  | { type: 'gameOver'; winner: PlayerId; reason: GameEndReason };

export interface StepResult {
  state: GameState;
  events: GameEvent[];
}
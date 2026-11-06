// The app's state and everything that changes it. No DOM code here, so it can be tested in Node.
import {
  IllegalActionError, createGame, legalActions, step,
  type ActionBody, type ActionPrompt, type BoardDef, type GameState, type PlayerId, type SquareId,
} from '../engine/index.ts';
import { BOTS } from '../bots/index.ts';
import { STARTER_BOARD } from '../boards/starter.ts';
import { describeEvent } from '../describe.ts';

export const GAME_TITLE = 'Dividend Drive';

export type BotKind = 'balanced' | 'landlord' | 'trader' | 'random';
export type SeatKind = 'human' | BotKind;

export interface Seat {
  name: string;
  kind: SeatKind;
}

export const SEAT_KINDS: { kind: SeatKind; label: string }[] = [
  { kind: 'human', label: 'Human' },
  { kind: 'balanced', label: 'Bot: balanced' },
  { kind: 'trader', label: 'Bot: trader (loves stocks)' },
  { kind: 'landlord', label: 'Bot: landlord (no stocks)' },
  { kind: 'random', label: 'Bot: random (very weak)' },
];

export const GAME_LENGTHS = [
  { id: 'short', label: 'Short (target 6,000G, about 30 rounds)', target: 6000 },
  { id: 'standard', label: 'Standard (target 8,000G, about 35 rounds)', target: 8000 },
  { id: 'long', label: 'Long (target 10,000G, about 40 rounds)', target: 10000 },
] as const;

export interface GameSetup {
  seats: Seat[]; // 2-4, in the order entered
  target: number;
  ventureCards: boolean;
  catchUpCash: boolean; // later seats start with +125G each
  randomOrder: boolean;
  maxRounds?: number | null;
  seed?: number;
  board?: BoardDef; // defaults to the starter board
}

export interface AppState {
  seats: Seat[]; // index = player id = turn order
  game: GameState;
  log: string[]; // oldest first
  selected: SquareId | null; // square shown in the info panel
  routeFor: SquareId | null; // destination clicked that has several routes
  error: string | null;
}

const MAX_LOG = 400;

export function startGame(setup: GameSetup, rand: () => number = Math.random): AppState {
  const seats = setup.seats.map((s, i) => ({ ...s, name: s.name.trim() || `Player ${i + 1}` }));
  if (setup.randomOrder) {
    for (let i = seats.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [seats[i], seats[j]] = [seats[j], seats[i]];
    }
  }
  const game = createGame({
    board: setup.board ?? STARTER_BOARD,
    players: seats.map((s) => s.name),
    config: {
      targetNetWorth: setup.target,
      ventureCards: setup.ventureCards,
      seatCashBonus: setup.catchUpCash ? 125 : 0,
      maxRounds: setup.maxRounds ?? null,
      randomTurnOrder: false, // already shuffled above, so seats and players stay matched
    },
    seed: setup.seed ?? Math.floor(rand() * 0x7fffffff),
  });
  const order = seats.map((s, i) => `${i + 1}. ${s.name}`).join(', ');
  return {
    seats,
    game,
    log: [`Game started. Turn order: ${order}. First to reach the bank with ${setup.target.toLocaleString('en-US')}G net worth wins.`, `--- Round 1: ${seats[0].name} ---`],
    selected: null,
    routeFor: null,
    error: null,
  };
}

/** Who must act now and what they may do, or null when the game is over. */
export function currentPrompt(app: AppState): ActionPrompt | null {
  return legalActions(app.game);
}

export function isHuman(app: AppState, p: PlayerId): boolean {
  return app.seats[p].kind === 'human';
}

export function isBotTurn(app: AppState): boolean {
  const prompt = currentPrompt(app);
  return prompt !== null && !isHuman(app, prompt.player);
}

/** Applies an action for whoever must act now. Illegal actions are reported, not thrown. */
export function applyAction(app: AppState, body: ActionBody): AppState {
  const prompt = currentPrompt(app);
  if (!prompt) return app;
  try {
    const { state, events } = step(app.game, { ...body, player: prompt.player });
    const lines = events.map((e) => describeEvent(state, e));
    return { ...app, game: state, log: [...app.log, ...lines].slice(-MAX_LOG), routeFor: null, error: null };
  } catch (err) {
    if (err instanceof IllegalActionError) return { ...app, error: `That move isn't allowed right now. (${err.message})` };
    throw err;
  }
}

/** Lets the bot whose turn it is make one decision. */
export function botStep(app: AppState, rand: () => number = Math.random): AppState {
  const prompt = currentPrompt(app);
  if (!prompt || isHuman(app, prompt.player)) return app;
  const bot = BOTS[app.seats[prompt.player].kind]();
  return applyAction(app, bot.chooseAction(app.game, prompt, rand));
}

/** Paths the current human player could take that end on this square. */
export function routesTo(app: AppState, square: SquareId): SquareId[][] {
  const prompt = currentPrompt(app);
  if (!prompt || !isHuman(app, prompt.player) || app.game.phase.kind !== 'move') return [];
  return prompt.choices.flatMap((c) => (c.type === 'move' && c.path[c.path.length - 1] === square ? [c.path] : []));
}

/** Board click: moves there if it's a destination with one route, otherwise shows the square's details. */
export function clickSquare(app: AppState, square: SquareId): AppState {
  const routes = routesTo(app, square);
  if (routes.length === 1) return applyAction({ ...app, selected: square }, { type: 'move', path: routes[0] });
  if (routes.length > 1) return { ...app, selected: square, routeFor: square };
  return { ...app, selected: app.selected === square ? null : square };
}

// ---------- Saving (the game survives page reloads) ----------

export interface SaveFile {
  version: 1;
  seats: Seat[];
  game: GameState;
  log: string[];
}

export function toSave(app: AppState): string {
  const save: SaveFile = { version: 1, seats: app.seats, game: app.game, log: app.log };
  return JSON.stringify(save);
}

export function fromSave(text: string | null): AppState | null {
  if (!text) return null;
  try {
    const save = JSON.parse(text) as SaveFile;
    if (save.version !== 1 || !save.game?.players || save.seats?.length !== save.game.players.length) return null;
    const app: AppState = { seats: save.seats, game: save.game, log: save.log ?? [], selected: null, routeFor: null, error: null };
    currentPrompt(app); // throws if the save doesn't fit this version of the game
    return app;
  } catch {
    return null;
  }
}
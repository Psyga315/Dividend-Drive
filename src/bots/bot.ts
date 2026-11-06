// What every bot looks like, and a loop that plays a whole game with bots.
import {
  createGame, legalActions, makeRandom, step,
  type ActionBody, type ActionPrompt, type BoardDef, type Config, type GameEvent, type GameState,
} from '../engine/index.ts';

export interface Bot {
  readonly name: string;
  /** Pick one action. It must come from prompt.choices (amounts within the given ranges). */
  chooseAction(state: GameState, prompt: ActionPrompt, rand: () => number): ActionBody;
}

export interface PlayOptions {
  board: BoardDef;
  bots: Bot[]; // seat order = turn order (random turn order is switched off)
  config?: Partial<Config>;
  seed: number;
  /** Called after every action, e.g. to print a log or count events. */
  onStep?: (state: GameState, events: GameEvent[]) => void;
  maxActions?: number;
}

/** Plays one game to the end and returns the final state. */
export function playGame(opts: PlayOptions): GameState {
  let state = createGame({
    board: opts.board,
    players: opts.bots.map((bot, i) => `P${i + 1} (${bot.name})`),
    config: { ...opts.config, randomTurnOrder: false },
    seed: opts.seed,
  });
  const rand = makeRandom(Math.imul(opts.seed, 2654435761));
  const limit = opts.maxActions ?? 200_000;
  for (let actions = 0; ; actions++) {
    const prompt = legalActions(state);
    if (!prompt) return state;
    if (actions >= limit) throw new Error(`Game did not finish within ${limit} actions (seed ${opts.seed})`);
    const action = opts.bots[prompt.player].chooseAction(state, prompt, rand);
    const result = step(state, { ...action, player: prompt.player });
    opts.onStep?.(result.state, result.events);
    state = result.state;
  }
}
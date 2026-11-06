export { playGame, type Bot, type PlayOptions } from './bot.ts';
export { randomBot, randomAction } from './random.ts';
export { heuristicBot, PERSONALITIES, type Personality } from './heuristic.ts';

import type { Bot } from './bot.ts';
import { randomBot } from './random.ts';
import { PERSONALITIES, heuristicBot } from './heuristic.ts';

/** Every bot by name, for the simulator and (later) the game setup screen. */
export const BOTS: Record<string, () => Bot> = {
  random: () => randomBot(),
  balanced: () => heuristicBot('balanced', PERSONALITIES.balanced),
  landlord: () => heuristicBot('landlord', PERSONALITIES.landlord),
  trader: () => heuristicBot('trader', PERSONALITIES.trader),
};
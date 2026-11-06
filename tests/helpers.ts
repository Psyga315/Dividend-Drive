// Shared setup for tests. Tests may edit a state directly to set up a situation;
// the engine itself only ever changes state through step().
import { createGame, step, type ActionBody, type Config, type GameEvent, type GameState, type PlayerId, type SquareId } from '../src/engine/index.ts';
import { STARTER_BOARD } from '../src/boards/starter.ts';

export const [P1, P2, P3, P4] = [0, 1, 2, 3];

/** Starter board, 4 players in fixed order P1..P4, 1500 cash each (no later-seat bonus). */
export function newGame(config: Partial<Config> = {}, seed = 1): GameState {
  return createGame({
    board: STARTER_BOARD,
    players: ['P1', 'P2', 'P3', 'P4'],
    config: { randomTurnOrder: false, seatCashBonus: 0, ...config },
    seed,
  });
}

export function give(s: GameState, owner: PlayerId, ...ids: SquareId[]): void {
  for (const id of ids) s.shops[id].owner = owner;
}

/** Make it `player`'s turn, standing on `at` (arrived from `cameFrom`), about to move `remaining` squares. */
export function readyToMove(s: GameState, player: PlayerId, at: SquareId, cameFrom: SquareId | null, remaining: number): void {
  s.turn = { player, roll: remaining, invested: 0, netTrades: {} };
  s.players[player].position = at;
  s.players[player].cameFrom = cameFrom;
  s.phase = { kind: 'move', remaining };
}

export function act(s: GameState, player: PlayerId, body: ActionBody) {
  return step(s, { ...body, player });
}

export const phaseOf = (s: GameState): string => s.phase.kind;
export const types = (events: GameEvent[]): string[] => events.map((e) => e.type);
export const cash = (s: GameState): number[] => s.players.map((p) => p.cash);
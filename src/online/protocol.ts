// Messages between the browser and the game server (online play). Used by both sides.
// The server runs the real game; browsers only send what a player clicked and show what they're sent.
import type { ActionBody, GameState } from '../engine/index.ts';
import type { BotKind, SeatKind } from '../ui/app.ts';

export type BotSpeed = 'slow' | 'normal' | 'fast';
export const BOT_SPEED_MS: Record<BotSpeed, number> = { slow: 1400, normal: 800, fast: 300 };

export interface RoomOptions {
  target: number;
  ventureCards: boolean;
  catchUpCash: boolean;
  randomOrder: boolean;
  botSpeed: BotSpeed;
  maxRounds: number | null; // not shown in the lobby; used by tests
}

export const DEFAULT_ROOM_OPTIONS: RoomOptions = {
  target: 8000,
  ventureCards: false,
  catchUpCash: true,
  randomOrder: true,
  botSpeed: 'normal',
  maxRounds: null,
};

export interface SeatView {
  name: string;
  kind: SeatKind;
  connected: boolean; // bots always count as connected
  standIn: boolean; // a bot is playing for this (offline) human
}

export interface RoomView {
  code: string;
  you: number; // your seat: index into `seats` (= your player id once the game has started)
  hostSeat: number;
  seats: SeatView[];
  options: RoomOptions;
  /** null = still in the lobby. Secrets are removed: dice seed, venture deck order, sealed auction bids. */
  game: GameState | null;
  /** Number of game actions so far. Sent back with each move, so a stale double-click is ignored. */
  step: number;
  log: string[];
}

export type Command =
  | { type: 'act'; step: number; action: ActionBody }
  | { type: 'setOptions'; options: Partial<RoomOptions> } // host, lobby
  | { type: 'addBot'; kind: BotKind } // host, lobby
  | { type: 'removeSeat'; seat: number } // host, lobby
  | { type: 'start' } // host, lobby
  | { type: 'standIn'; seat: number } // anyone, during a game: a bot plays for an offline player
  | { type: 'backToLobby' } // anyone, after the game
  | { type: 'leave' }; // lobby

export type ClientMessage =
  | { type: 'hello'; code: string; token: string }
  | { type: 'command'; id: number; command: Command }
  | { type: 'ping' };

export type EndReason = 'roomGone' | 'badToken' | 'kicked' | 'left';

export type ServerMessage =
  | { type: 'view'; view: RoomView }
  | { type: 'result'; id: number; ok: true }
  | { type: 'result'; id: number; ok: false; status: number; error: string }
  | { type: 'ended'; reason: EndReason; message: string }
  | { type: 'pong' };

/** WebSocket close codes for sessions the server ends on purpose (the browser won't reconnect). */
export const CLOSE_CODES: Record<EndReason, number> = { roomGone: 4004, badToken: 4001, kicked: 4002, left: 4003 };

export const ENDED_MESSAGES: Record<EndReason, string> = {
  roomGone: 'That room has closed. Rooms close when the server restarts or after 2 hours with nobody connected.',
  badToken: "You're no longer in that room.",
  kicked: 'The host removed you from the room.',
  left: 'You left the room.',
};

/** Error text for a move made from an out-of-date screen. The browser ignores it quietly. */
export const STALE = 'stale';

export const MAX_NAME_LENGTH = 16;
export const CODE_LENGTH = 5;

export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH).trim();
}

export function normalizeCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : '';
}

/** A copy of the game that's safe to show players: no dice seed, no venture deck order, no sealed bids. */
export function redactState(s: GameState): GameState {
  const phase = s.phase.kind === 'auction' ? { ...s.phase, bids: s.phase.bids.map((b) => (b === null ? null : 0)) } : s.phase;
  return { ...s, phase, rng: 0, deck: [] };
}
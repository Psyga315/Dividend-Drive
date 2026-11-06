// Online rooms: the lobby, seats, and the game itself, which runs here on the server.
// No networking in this file (see http.ts), so it can be tested directly.
import { randomInt, randomUUID } from 'node:crypto';
import { legalActions, type ActionBody } from '../engine/index.ts';
import { BOTS } from '../bots/index.ts';
import { BOT_KINDS, applyAction, startGame, type AppState, type BotKind, type SeatKind } from '../ui/app.ts';
import {
  BOT_SPEED_MS, CODE_LENGTH, DEFAULT_ROOM_OPTIONS, STALE, cleanName, normalizeCode, redactState,
  type BotSpeed, type Command, type EndReason, type RoomOptions, type RoomView,
} from '../online/protocol.ts';

/** An error to report back to the player, with an HTTP-style status code. */
export class RoomError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RoomError';
    this.status = status;
  }
}

/** A connected browser tab. */
export interface Listener {
  token: string;
  send(view: RoomView): void;
  end(reason: EndReason, message: string): void;
}

interface Seat {
  token: string | null; // null for bots
  name: string;
  kind: SeatKind;
  connections: number;
  standIn: boolean;
}

interface Room {
  code: string;
  hostToken: string;
  seats: Seat[]; // lobby: join order; during a game: turn order (seat i = player i)
  options: RoomOptions;
  app: AppState | null; // null = lobby
  step: number;
  lastActivity: number;
  listeners: Set<Listener>;
  botTimer: ReturnType<typeof setTimeout> | null;
}

export interface RoomManagerOptions {
  /** Pause between bot moves. 0 = bots move instantly (for tests). Default: each room's bot speed. */
  botDelayMs?: number;
  maxRooms?: number;
  /** Rooms with nobody connected are deleted after this long. Default 2 hours. */
  roomIdleMs?: number;
  now?: () => number;
  random?: () => number;
}

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: they look like 1 and 0
const MAX_SEATS = 4;
const LOG_LINES = 300;
const BOT_NAMES = ['Ada', 'Ben', 'Cy', 'Dee', 'Eve', 'Finn', 'Gus', 'Hal'];

export class RoomManager {
  rooms = new Map<string, Room>();
  #botDelayMs: number | undefined;
  #maxRooms: number;
  #roomIdleMs: number;
  #now: () => number;
  #random: () => number;

  constructor(opts: RoomManagerOptions = {}) {
    this.#botDelayMs = opts.botDelayMs;
    this.#maxRooms = opts.maxRooms ?? 500;
    this.#roomIdleMs = opts.roomIdleMs ?? 2 * 60 * 60 * 1000;
    this.#now = opts.now ?? Date.now;
    this.#random = opts.random ?? Math.random;
  }

  // ---------- Joining ----------

  createRoom(rawName: unknown): { code: string; token: string } {
    const name = requireName(rawName);
    if (this.rooms.size >= this.#maxRooms) this.sweep();
    if (this.rooms.size >= this.#maxRooms) throw new RoomError(503, 'The server is full right now. Try again later.');
    const code = this.#newCode();
    const token = randomUUID();
    this.rooms.set(code, {
      code,
      hostToken: token,
      seats: [{ token, name, kind: 'human', connections: 0, standIn: false }],
      options: { ...DEFAULT_ROOM_OPTIONS },
      app: null,
      step: 0,
      lastActivity: this.#now(),
      listeners: new Set(),
      botTimer: null,
    });
    return { code, token };
  }

  joinRoom(rawCode: unknown, rawName: unknown): { code: string; token: string } {
    const room = this.#room(rawCode);
    const name = requireName(rawName);
    if (room.app) throw new RoomError(409, 'That game has already started.');
    if (room.seats.length >= MAX_SEATS) throw new RoomError(409, 'That room is full (4 players).');
    const token = randomUUID();
    room.seats.push({ token, name: uniqueName(room, name), kind: 'human', connections: 0, standIn: false });
    this.#touch(room);
    this.#changed(room);
    return { code: room.code, token };
  }

  /** Connects a browser tab. It gets the current view right away, then every change. Returns "disconnect". */
  subscribe(rawCode: unknown, token: string, listener: Listener): () => void {
    const room = this.rooms.get(normalizeCode(rawCode));
    if (!room) {
      listener.end('roomGone', 'That room has closed.');
      return () => {};
    }
    const seat = room.seats.find((s) => s.token !== null && s.token === token);
    if (!seat) {
      listener.end('badToken', "You're not in this room any more.");
      return () => {};
    }
    room.listeners.add(listener);
    seat.connections += 1;
    seat.standIn = false; // they're back: the bot stops playing for them
    this.#touch(room);
    this.#changed(room);
    return () => {
      if (!room.listeners.delete(listener)) return;
      const s = room.seats.find((x) => x.token === listener.token);
      if (s) s.connections = Math.max(0, s.connections - 1);
      this.#touch(room);
      if (this.rooms.has(room.code)) this.#broadcast(room);
    };
  }

  // ---------- Commands ----------

  command(rawCode: unknown, token: string, raw: unknown): void {
    const room = this.#room(rawCode);
    const me = room.seats.findIndex((s) => s.token !== null && s.token === token);
    if (me < 0) throw new RoomError(403, "You're not in this room.");
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') throw new RoomError(400, 'Bad command.');
    const cmd = raw as Command;
    const isHost = token === room.hostToken;
    const hostOnly = () => {
      if (!isHost) throw new RoomError(403, 'Only the host can do that.');
    };
    const lobbyOnly = () => {
      if (room.app) throw new RoomError(409, 'The game has already started.');
    };
    this.#touch(room);

    switch (cmd.type) {
      case 'act': {
        if (!room.app) throw new RoomError(409, "The game hasn't started yet.");
        if (cmd.step !== room.step) throw new RoomError(409, STALE);
        const prompt = legalActions(room.app.game);
        if (!prompt) throw new RoomError(409, 'The game is over.');
        if (prompt.player !== me) throw new RoomError(403, "It's not your turn.");
        room.seats[me].standIn = false;
        const next = applyAction(room.app, cmd.action as ActionBody);
        if (next.error) throw new RoomError(400, next.error);
        room.app = next;
        room.step += 1;
        break;
      }
      case 'setOptions':
        hostOnly();
        lobbyOnly();
        room.options = mergeOptions(room.options, cmd.options);
        break;
      case 'addBot': {
        hostOnly();
        lobbyOnly();
        if (!BOT_KINDS.includes(cmd.kind)) throw new RoomError(400, 'Unknown bot type.');
        if (room.seats.length >= MAX_SEATS) throw new RoomError(409, 'The room is full (4 players).');
        const name = BOT_NAMES.find((n) => !room.seats.some((s) => s.name.toLowerCase() === n.toLowerCase())) ?? 'Bot';
        room.seats.push({ token: null, name: uniqueName(room, name), kind: cmd.kind, connections: 0, standIn: false });
        break;
      }
      case 'removeSeat': {
        hostOnly();
        lobbyOnly();
        const seat = room.seats[cmd.seat];
        if (!seat) throw new RoomError(400, 'No such seat.');
        if (cmd.seat === me) throw new RoomError(400, 'Use "Leave room" to leave.');
        room.seats.splice(cmd.seat, 1);
        if (seat.token) this.#endListeners(room, seat.token, 'kicked', 'The host removed you from the room.');
        break;
      }
      case 'start':
        hostOnly();
        lobbyOnly();
        this.#start(room);
        break;
      case 'standIn': {
        if (!room.app || room.app.game.phase.kind === 'gameOver') throw new RoomError(409, 'No game is running.');
        const seat = room.seats[cmd.seat];
        if (!seat || seat.kind !== 'human') throw new RoomError(400, 'Only human players need a stand-in.');
        if (seat.connections > 0) throw new RoomError(409, `${seat.name} is online.`);
        seat.standIn = true;
        break;
      }
      case 'backToLobby':
        if (!room.app) throw new RoomError(409, "You're already in the lobby.");
        if (room.app.game.phase.kind !== 'gameOver') throw new RoomError(409, 'The game is still going.');
        room.app = null;
        room.step = 0;
        for (const s of room.seats) s.standIn = false;
        break;
      case 'leave': {
        lobbyOnly();
        room.seats.splice(me, 1);
        this.#endListeners(room, token, 'left', 'You left the room.');
        if (isHost) {
          const next = room.seats.find((s) => s.token !== null);
          if (!next) {
            this.#delete(room);
            return;
          }
          room.hostToken = next.token!;
        }
        break;
      }
      default:
        throw new RoomError(400, 'Unknown command.');
    }
    this.#changed(room);
  }

  // ---------- Views, housekeeping ----------

  /** What one player sees. */
  view(rawCode: unknown, token: string): RoomView {
    return this.#viewFor(this.#room(rawCode), token);
  }

  /** Deletes rooms that nobody has been connected to for a while. Returns how many were deleted. */
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const room of [...this.rooms.values()]) {
      if (room.listeners.size === 0 && now - room.lastActivity > this.#roomIdleMs) {
        this.#delete(room);
        removed += 1;
      }
    }
    return removed;
  }

  /** Stops all bot timers (server shutdown, tests). */
  close(): void {
    for (const room of this.rooms.values()) if (room.botTimer) clearTimeout(room.botTimer);
    this.rooms.clear();
  }

  // ---------- Internals ----------

  #room(rawCode: unknown): Room {
    const room = this.rooms.get(normalizeCode(rawCode));
    if (!room) throw new RoomError(404, 'No room with that code. Check the code, or ask for a new invite link.');
    return room;
  }

  #newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  #touch(room: Room): void {
    room.lastActivity = this.#now();
  }

  #start(room: Room): void {
    if (room.seats.length < 2) throw new RoomError(409, 'You need at least 2 players. Add a bot or invite a friend.');
    if (room.options.randomOrder) {
      for (let i = room.seats.length - 1; i > 0; i--) {
        const j = Math.floor(this.#random() * (i + 1));
        [room.seats[i], room.seats[j]] = [room.seats[j], room.seats[i]];
      }
    }
    const o = room.options;
    room.app = startGame(
      {
        seats: room.seats.map((s) => ({ name: s.name, kind: s.kind })),
        target: o.target,
        ventureCards: o.ventureCards,
        catchUpCash: o.catchUpCash,
        randomOrder: false, // shuffled above, so seat i = player i
        maxRounds: o.maxRounds,
      },
      this.#random,
    );
    room.step = 0;
    for (const s of room.seats) s.standIn = false;
  }

  #viewFor(room: Room, token: string): RoomView {
    return {
      code: room.code,
      you: room.seats.findIndex((s) => s.token === token),
      hostSeat: room.seats.findIndex((s) => s.token === room.hostToken),
      seats: room.seats.map((s) => ({ name: s.name, kind: s.kind, connected: s.kind !== 'human' || s.connections > 0, standIn: s.standIn })),
      options: { ...room.options },
      game: room.app ? redactState(room.app.game) : null,
      step: room.step,
      log: room.app ? room.app.log.slice(-LOG_LINES) : [],
    };
  }

  #broadcast(room: Room): void {
    for (const listener of room.listeners) {
      try {
        listener.send(this.#viewFor(room, listener.token));
      } catch (err) {
        console.error('Could not send a room update:', err);
      }
    }
  }

  #changed(room: Room): void {
    this.#broadcast(room);
    this.#scheduleBots(room);
  }

  #endListeners(room: Room, token: string, reason: EndReason, message: string): void {
    for (const listener of [...room.listeners]) {
      if (listener.token !== token) continue;
      room.listeners.delete(listener);
      listener.end(reason, message);
    }
  }

  #delete(room: Room): void {
    if (room.botTimer) clearTimeout(room.botTimer);
    room.botTimer = null;
    this.rooms.delete(room.code);
    for (const listener of [...room.listeners]) listener.end('roomGone', 'That room has closed.');
    room.listeners.clear();
  }

  /** Is it a bot's move (or a bot standing in for an offline player)? */
  #botControlled(room: Room): boolean {
    if (!room.app) return false;
    const prompt = legalActions(room.app.game);
    if (!prompt) return false;
    const seat = room.seats[prompt.player];
    return seat.kind !== 'human' || seat.standIn;
  }

  #scheduleBots(room: Room): void {
    if (room.botTimer || !this.rooms.has(room.code) || !this.#botControlled(room)) return;
    const delay = this.#botDelayMs ?? BOT_SPEED_MS[room.options.botSpeed];
    if (delay === 0) {
      for (let guard = 0; guard < 100_000 && this.#botControlled(room); guard++) this.#botMove(room);
      this.#broadcast(room);
      return;
    }
    room.botTimer = setTimeout(() => {
      room.botTimer = null;
      if (!this.rooms.has(room.code) || !this.#botControlled(room)) return;
      try {
        this.#botMove(room);
      } catch (err) {
        console.error(`Bot move failed in room ${room.code}:`, err);
        return;
      }
      this.#broadcast(room);
      this.#scheduleBots(room);
    }, delay);
  }

  #botMove(room: Room): void {
    const app = room.app!;
    const prompt = legalActions(app.game)!;
    const seat = room.seats[prompt.player];
    const kind: BotKind = seat.kind === 'human' ? 'balanced' : seat.kind;
    const action = BOTS[kind]().chooseAction(app.game, prompt, this.#random);
    const next = applyAction(app, action);
    if (next.error) throw new Error(`Bot made an illegal move: ${next.error}`);
    room.app = next;
    room.step += 1;
  }
}

// ---------- Helpers ----------

function requireName(raw: unknown): string {
  const name = cleanName(raw);
  if (!name) throw new RoomError(400, 'Enter your name first.');
  return name;
}

/** "Ada", or "Ada 2" if someone in the room already has that name. */
function uniqueName(room: Room, name: string): string {
  const taken = (n: string) => room.seats.some((s) => s.name.toLowerCase() === n.toLowerCase());
  if (!taken(name)) return name;
  for (let i = 2; ; i++) {
    const suffix = ` ${i}`;
    const candidate = name.slice(0, 16 - suffix.length) + suffix;
    if (!taken(candidate)) return candidate;
  }
}

function mergeOptions(current: RoomOptions, raw: unknown): RoomOptions {
  if (!raw || typeof raw !== 'object') throw new RoomError(400, 'Bad options.');
  const o = raw as Record<string, unknown>;
  const next = { ...current };
  const bad = (what: string) => new RoomError(400, `Bad value for ${what}.`);
  if ('target' in o) {
    if (!Number.isInteger(o.target) || (o.target as number) < 1000 || (o.target as number) > 100_000) throw bad('target');
    next.target = o.target as number;
  }
  for (const key of ['ventureCards', 'catchUpCash', 'randomOrder'] as const) {
    if (!(key in o)) continue;
    if (typeof o[key] !== 'boolean') throw bad(key);
    next[key] = o[key] as boolean;
  }
  if ('botSpeed' in o) {
    if (typeof o.botSpeed !== 'string' || !(o.botSpeed in BOT_SPEED_MS)) throw bad('bot speed');
    next.botSpeed = o.botSpeed as BotSpeed;
  }
  if ('maxRounds' in o) {
    const m = o.maxRounds;
    if (m !== null && (!Number.isInteger(m) || (m as number) < 5 || (m as number) > 500)) throw bad('round limit');
    next.maxRounds = m as number | null;
  }
  return next;
}
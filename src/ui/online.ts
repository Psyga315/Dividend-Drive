// Online play in the browser: talks to the game server (a small rooms API, then one WebSocket).
// The server runs the game; this only sends clicks and receives what to show.
import type { ActionBody } from '../engine/index.ts';
import {
  CLOSE_CODES, ENDED_MESSAGES,
  type ClientMessage, type Command, type EndReason, type RoomView, type ServerMessage,
} from '../online/protocol.ts';

export interface Session {
  server: string; // e.g. "https://example.trycloudflare.com"
  code: string;
  token: string; // proves which seat is yours; kept in the browser so you can reconnect
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'ended';
export type CommandResult = { ok: true } | { ok: false; status: number; error: string };

export function normalizeServer(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function socketUrl(server: string): string {
  return normalizeServer(server).replace(/^http/i, 'ws') + '/api/ws';
}

/** Is there a Dividend Drive server at this address? (False on GitHub Pages, which only hosts files.) */
export async function serverAvailable(server: string): Promise<boolean> {
  try {
    const res = await fetch(`${normalizeServer(server)}/api/health`, { cache: 'no-store' });
    if (!res.ok) return false;
    const data = (await res.json()) as { game?: string };
    return data.game === 'dividend-drive';
  } catch {
    return false;
  }
}

async function post(server: string, path: string, body: unknown): Promise<{ code: string; token: string }> {
  let res: Response;
  try {
    res = await fetch(normalizeServer(server) + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach the game server. Is it still running?");
  }
  const data = (await res.json().catch(() => ({}))) as { code?: string; token?: string; error?: string };
  if (!res.ok || !data.code || !data.token) throw new Error(data.error ?? `The server answered with error ${res.status}.`);
  return { code: data.code, token: data.token };
}

export async function createRoom(server: string, name: string): Promise<Session> {
  return { server: normalizeServer(server), ...(await post(server, '/api/rooms', { name })) };
}

export async function joinRoom(server: string, code: string, name: string): Promise<Session> {
  return { server: normalizeServer(server), ...(await post(server, `/api/rooms/${encodeURIComponent(code)}/join`, { name })) };
}

export interface OnlineEvents {
  onView(view: RoomView): void;
  onStatus(status: ConnectionStatus): void;
  /** The server ended this session on purpose (room closed, removed by host, left). */
  onEnded(reason: EndReason, message: string): void;
}

type WebSocketClass = new (url: string) => WebSocket;

/** One connection to one room. Reconnects by itself if the connection drops. */
export class OnlineClient {
  session: Session;
  view: RoomView | null = null;
  status: ConnectionStatus = 'connecting';
  #events: OnlineEvents;
  #WS: WebSocketClass;
  #ws: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<number, (result: CommandResult) => void>();
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(session: Session, events: OnlineEvents, WS: WebSocketClass = WebSocket) {
    this.session = session;
    this.#events = events;
    this.#WS = WS;
  }

  connect(): void {
    if (this.#stopped || this.#ws) return;
    const ws = new this.#WS(socketUrl(this.session.server));
    this.#ws = ws;
    ws.onopen = () => {
      this.#attempt = 0;
      this.#send({ type: 'hello', code: this.session.code, token: this.session.token });
      this.#setStatus('open');
      // Some hosts (e.g. Render's free plan) go to sleep without incoming traffic; this keeps the room awake.
      this.#heartbeat = setInterval(() => this.#send({ type: 'ping' }), 30_000);
    };
    ws.onmessage = (e) => this.#receive(String(e.data));
    ws.onclose = (e) => this.#closed(ws, e.code);
    ws.onerror = () => {}; // a close event always follows
  }

  /** Leave the connection for good (no reconnecting). */
  close(): void {
    this.#stopped = true;
    this.#cleanup();
    this.#setStatus('ended');
  }

  command(command: Command): Promise<CommandResult> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      return Promise.resolve({ ok: false, status: 0, error: 'Not connected right now. Try again in a moment.' });
    }
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#send({ type: 'command', id, command });
    });
  }

  /** Sends a game move made on the current view. */
  act(action: ActionBody): Promise<CommandResult> {
    return this.command({ type: 'act', step: this.view?.step ?? -1, action });
  }

  #send(msg: ClientMessage): void {
    if (this.#ws && this.#ws.readyState === 1) this.#ws.send(JSON.stringify(msg));
  }

  #receive(text: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'view':
        this.view = msg.view;
        this.#events.onView(msg.view);
        return;
      case 'result': {
        const done = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        done?.(msg.ok ? { ok: true } : { ok: false, status: msg.status, error: msg.error });
        return;
      }
      case 'ended':
        this.#end(msg.reason, msg.message);
        return;
      case 'pong':
        return;
    }
  }

  #closed(ws: WebSocket, code: number): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#stopHeartbeat();
    this.#failPending('The connection dropped. Try again in a moment.');
    if (this.#stopped) return;
    const reason = (Object.keys(CLOSE_CODES) as EndReason[]).find((r) => CLOSE_CODES[r] === code);
    if (reason) {
      this.#end(reason, ENDED_MESSAGES[reason]);
      return;
    }
    this.#setStatus('reconnecting');
    const delay = Math.min(10_000, 500 * 2 ** this.#attempt);
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
  }

  #end(reason: EndReason, message: string): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cleanup();
    this.#setStatus('ended');
    this.#events.onEnded(reason, message);
  }

  #cleanup(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#stopHeartbeat();
    const ws = this.#ws;
    this.#ws = null;
    if (ws && ws.readyState <= 1) ws.close(1000);
    this.#failPending('You left the room.');
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  #failPending(error: string): void {
    for (const done of this.#pending.values()) done({ ok: false, status: 0, error });
    this.#pending.clear();
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.#events.onStatus(status);
  }
}
// The game server: serves the game's files, a small rooms API, and live updates over WebSocket.
// Plain Node.js, no packages. Start it with `npm run server` (see scripts/serve.ts).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { CLOSE_CODES, type ClientMessage, type ServerMessage } from '../online/protocol.ts';
import { RoomError, RoomManager, type Listener } from './rooms.ts';
import { acceptWebSocket, type WebSocketConnection } from './websocket.ts';

export interface GameServerOptions {
  /** Folder with index.html, style.css and the built dist/ folder. */
  webDir: string;
  manager?: RoomManager;
  /** How often idle rooms are cleaned up. Default 5 minutes. */
  sweepIntervalMs?: number;
  /** WebSocket keep-alive pings. Default 30 s. */
  pingIntervalMs?: number;
  /** Development: pages reload themselves when reload() is called (used by `npm run dev`). */
  liveReload?: boolean;
}

export interface GameServer {
  server: Server;
  manager: RoomManager;
  /** Tells open pages to reload (only with liveReload). */
  reload(): void;
  stop(): Promise<void>;
}

const RELOAD_SNIPPET = `<script>new EventSource('/__reload').onmessage = () => location.reload();</script>`;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// The API may be used from another site (e.g. the GitHub Pages copy with ?server=...).
// Rooms are protected by tokens, not cookies, so allowing any origin is safe.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const MAX_BODY_BYTES = 16 * 1024;

export function createGameServer(opts: GameServerOptions): GameServer {
  const webDir = resolve(opts.webDir);
  const manager = opts.manager ?? new RoomManager();
  const sockets = new Set<WebSocketConnection>();
  const reloadClients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    handleHttp(req, res).catch((err) => {
      const status = err instanceof RoomError ? err.status : 500;
      if (status === 500) console.error('Request failed:', err);
      const message = err instanceof RoomError ? err.message : 'Something went wrong on the server.';
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      throw new RoomError(400, 'Bad address.');
    }
    const method = req.method ?? 'GET';
    if (opts.liveReload && pathname === '/__reload') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      reloadClients.add(res);
      req.on('close', () => reloadClients.delete(res));
      return;
    }
    if (pathname.startsWith('/api/')) {
      if (method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }
      if (pathname === '/api/health' && method === 'GET') {
        sendJson(res, 200, { ok: true, game: 'dividend-drive', rooms: manager.rooms.size });
        return;
      }
      if (pathname === '/api/rooms' && method === 'POST') {
        const body = await readJson(req);
        sendJson(res, 201, manager.createRoom(body.name));
        return;
      }
      const join = pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/join$/);
      if (join && method === 'POST') {
        const body = await readJson(req);
        sendJson(res, 200, manager.joinRoom(join[1], body.name));
        return;
      }
      throw new RoomError(404, 'Unknown API address.');
    }
    await serveFile(req, res, pathname);
  }

  async function serveFile(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new RoomError(405, 'Method not allowed.');
    const file = normalize(join(webDir, pathname === '/' ? 'index.html' : pathname));
    const rel = relative(webDir, file);
    const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    if (!inside || pathname.includes('\0') || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Not found: ${pathname}`);
      return;
    }
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else if (opts.liveReload && ext === '.html') res.end((await readFile(file, 'utf8')).replace('</body>', `${RELOAD_SNIPPET}</body>`));
    else createReadStream(file).pipe(res);
  }

  // ---------- Live connection: one WebSocket per browser tab ----------

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/api/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket, head, { pingIntervalMs: opts.pingIntervalMs });
    if (!ws) return;
    sockets.add(ws);
    let room = '';
    let token = '';
    let disconnect: (() => void) | null = null;
    const send = (msg: ServerMessage) => ws.send(JSON.stringify(msg));

    ws.onMessage = (text) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(text) as ClientMessage;
      } catch {
        ws.close(4000, 'bad message');
        return;
      }
      if (!msg || typeof msg !== 'object') return ws.close(4000, 'bad message');
      switch (msg.type) {
        case 'ping':
          return send({ type: 'pong' });
        case 'hello': {
          if (disconnect) return; // already in a room
          room = String(msg.code ?? '');
          token = String(msg.token ?? '');
          const listener: Listener = {
            token,
            send: (view) => send({ type: 'view', view }),
            end: (reason, message) => {
              send({ type: 'ended', reason, message });
              ws.close(CLOSE_CODES[reason], reason);
            },
          };
          disconnect = manager.subscribe(room, token, listener);
          return;
        }
        case 'command': {
          const id = Number(msg.id);
          if (!disconnect) return send({ type: 'result', id, ok: false, status: 400, error: 'Not in a room yet.' });
          try {
            manager.command(room, token, msg.command);
            send({ type: 'result', id, ok: true });
          } catch (err) {
            const status = err instanceof RoomError ? err.status : 500;
            if (status === 500) console.error('Command failed:', err);
            const error = err instanceof RoomError ? err.message : 'Something went wrong on the server.';
            send({ type: 'result', id, ok: false, status, error });
          }
          return;
        }
        default:
          ws.close(4000, 'unknown message');
      }
    };
    ws.onClose = () => {
      sockets.delete(ws);
      disconnect?.();
      disconnect = null;
    };
  });

  const sweeper = setInterval(() => manager.sweep(), opts.sweepIntervalMs ?? 5 * 60 * 1000);
  unref(sweeper);

  return {
    server,
    manager,
    reload: () => {
      for (const res of reloadClients) res.write('data: reload\n\n');
    },
    stop: () =>
      new Promise<void>((done) => {
        clearInterval(sweeper);
        for (const res of reloadClients) res.end();
        reloadClients.clear();
        for (const ws of sockets) ws.close(1001, 'server stopping');
        manager.close();
        server.close(() => done());
        server.closeAllConnections?.();
      }),
  };
}

/** Lets Node exit even if this timer is still running. */
function unref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RoomError(413, 'Request too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    throw new RoomError(400, 'Bad request.');
  }
}
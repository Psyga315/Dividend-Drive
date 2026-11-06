// The real game server over the network: HTTP API, the WebSocket code, and whole online games
// played by two browser clients (OnlineClient, using Node's built-in WebSocket like a browser would).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legalActions, makeRandom } from '../src/engine/index.ts';
import { randomAction } from '../src/bots/index.ts';
import { createGameServer, type GameServer } from '../src/server/http.ts';
import { RoomManager } from '../src/server/rooms.ts';
import { acceptWebSocket } from '../src/server/websocket.ts';
import { OnlineClient, createRoom, joinRoom, serverAvailable, type Session } from '../src/ui/online.ts';
import type { EndReason, RoomView } from '../src/online/protocol.ts';

const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

async function startServer(): Promise<{ gs: GameServer; url: string; port: number }> {
  const gs = createGameServer({ webDir, manager: new RoomManager({ botDelayMs: 0, random: makeRandom(11) }) });
  await new Promise<void>((done) => gs.server.listen(0, '127.0.0.1', done));
  const port = (gs.server.address() as AddressInfo).port;
  return { gs, url: `http://127.0.0.1:${port}`, port };
}

function until(check: () => boolean, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for: ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** A browser tab: connects, and (if `play`) makes random legal moves whenever it's this seat's turn. */
function player(session: Session, seed: number, play: boolean, WS?: new (url: string) => WebSocket) {
  const rand = makeRandom(seed);
  const ended: EndReason[] = [];
  let actedOn = -1;
  const views: RoomView[] = [];
  const client = new OnlineClient(
    session,
    {
      onView: (view) => {
        views.push(view);
        if (!play || !view.game || view.step === actedOn) return;
        const prompt = legalActions(view.game);
        if (!prompt || prompt.player !== view.you) return;
        actedOn = view.step;
        void client.act(randomAction(prompt, rand));
      },
      onStatus: () => {},
      onEnded: (reason) => ended.push(reason),
    },
    WS,
  );
  client.connect();
  return { client, ended, views };
}

const gameOver = (c: OnlineClient) => c.view?.game?.phase.kind === 'gameOver';

test('HTTP: files, health check, rooms API, errors and CORS', async () => {
  const { gs, url, port } = await startServer();
  try {
    const page = await fetch(url + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await page.text(), /Dividend Drive/);
    assert.equal((await fetch(url + '/style.css')).status, 200);
    assert.equal((await fetch(url + '/nope.js')).status, 404);
    assert.equal(await rawStatus(port, '/../package.json'), 404);
    assert.equal(await rawStatus(port, '/%2e%2e/package.json'), 404);
    assert.equal(await serverAvailable(url), true);
    assert.equal(await serverAvailable('http://127.0.0.1:1'), false);

    const created = await fetch(url + '/api/rooms', { method: 'POST', body: JSON.stringify({ name: 'Ada' }) });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('access-control-allow-origin'), '*');
    const { code, token } = (await created.json()) as { code: string; token: string };
    assert.match(code, /^[A-Z]{5}$/);
    assert.ok(token.length > 20);
    const joined = await fetch(`${url}/api/rooms/${code.toLowerCase()}/join`, { method: 'POST', body: JSON.stringify({ name: 'Ben' }) });
    assert.equal(joined.status, 200);

    const bad = async (path: string, body: string, status: number) => {
      const res = await fetch(url + path, { method: 'POST', body });
      assert.equal(res.status, status, path);
      assert.ok(((await res.json()) as { error?: string }).error, 'errors come with a message');
    };
    await bad('/api/rooms', '{"name":"  "}', 400);
    await bad('/api/rooms', 'not json', 400);
    await bad('/api/rooms/ZZZZZ/join', '{"name":"Cy"}', 404);
    await bad('/api/nothing', '{}', 404);
    const preflight = await fetch(url + '/api/rooms', { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /POST/);
  } finally {
    await gs.stop();
  }
});

/** Status code for a request path sent exactly as written (fetch would clean up the ".."). */
function rawStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let text = '';
    socket.on('data', (d: Buffer) => (text += d.toString('utf8')));
    socket.on('close', () => resolve(Number(text.split(' ')[1])));
    socket.on('error', reject);
  });
}

test('two players and two bots play a whole online game; a dropped connection reconnects by itself', async () => {
  const { gs, url } = await startServer();
  const sockets: WebSocket[] = [];
  // Like the browser's WebSocket, but remembers each connection so the test can cut it.
  const Recording = class extends WebSocket {
    constructor(u: string) {
      super(u);
      sockets.push(this);
    }
  };
  try {
    const hostSession = await createRoom(url, 'Host');
    const guestSession = await joinRoom(url, hostSession.code, 'Guest');
    const host = player(hostSession, 1, true);
    const guest = player(guestSession, 2, true, Recording);
    await until(() => host.client.view?.seats.every((s) => s.connected) === true && guest.client.view !== null, 'both players in the lobby');
    assert.deepEqual(host.client.view!.seats.map((s) => s.name), ['Host', 'Guest']);
    assert.equal(guest.client.view!.you, 1);

    // Guests can't start; the host adds bots, sets options and starts.
    const refused = await guest.client.command({ type: 'start' });
    assert.deepEqual(refused, { ok: false, status: 403, error: 'Only the host can do that.' });
    for (const kind of ['balanced', 'trader'] as const) assert.deepEqual(await host.client.command({ type: 'addBot', kind }), { ok: true });
    await host.client.command({ type: 'setOptions', options: { target: 5000, maxRounds: 30, ventureCards: true } });
    await host.client.command({ type: 'start' });

    // Partway through, cut the guest's connection. The client should reconnect and carry on.
    await until(() => (guest.client.view?.step ?? 0) > 20, 'the game to get going');
    const before = sockets.length;
    sockets[sockets.length - 1].close();
    await until(() => sockets.length > before && guest.client.status === 'open', 'the guest to reconnect');

    await until(() => gameOver(host.client) && gameOver(guest.client), 'the game to finish', 60_000);
    assert.equal(host.client.view!.step, guest.client.view!.step);
    assert.deepEqual(host.ended, []);
    assert.deepEqual(guest.ended, []);
    for (const v of [...host.views, ...guest.views]) {
      if (v.game) assert.equal(v.game.rng, 0, 'the dice seed must never be sent');
    }

    // Rematch: back to the room, start again.
    await guest.client.command({ type: 'backToLobby' });
    await until(() => host.client.view?.game === null, 'everyone back in the lobby');
    host.client.close();
    guest.client.close();
  } finally {
    await gs.stop();
  }
});

test('removed players and closed rooms end the session (no endless reconnecting)', async () => {
  const { gs, url } = await startServer();
  try {
    const hostSession = await createRoom(url, 'Host');
    const guestSession = await joinRoom(url, hostSession.code, 'Guest');
    const host = player(hostSession, 1, false);
    const guest = player(guestSession, 2, false);
    await until(() => host.client.view?.seats[1]?.connected === true, 'guest connected');
    await host.client.command({ type: 'removeSeat', seat: 1 });
    await until(() => guest.ended.length > 0, 'guest told they were removed');
    assert.deepEqual(guest.ended, ['kicked']);
    assert.equal(guest.client.status, 'ended');

    const ghost = player({ ...hostSession, code: 'QQQQQ' }, 3, false);
    await until(() => ghost.ended.length > 0, 'unknown room reported');
    assert.deepEqual(ghost.ended, ['roomGone']);
    const impostor = player({ ...hostSession, token: 'wrong' }, 4, false);
    await until(() => impostor.ended.length > 0, 'bad token reported');
    assert.deepEqual(impostor.ended, ['badToken']);
    host.client.close();
  } finally {
    await gs.stop();
  }
});

// ---------- The WebSocket code itself ----------

test('WebSocket messages of every size arrive intact in both directions', async () => {
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head, { maxMessageBytes: 300_000, pingIntervalMs: 0 });
    if (ws) ws.onMessage = (text) => ws.send(text); // echo
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received: string[] = [];
  ws.onmessage = (e) => received.push(String(e.data));
  await new Promise((done) => (ws.onopen = done));
  // 125 bytes or less, 126-65535 (16-bit length), and over 65535 (64-bit length); also non-ASCII text.
  const messages = ['hi', 'x'.repeat(125), 'y'.repeat(126), 'é♠📈'.repeat(500), 'z'.repeat(65_535), 'w'.repeat(200_000)];
  for (const m of messages) ws.send(m);
  await until(() => received.length === messages.length, 'all echoes');
  assert.deepEqual(received.map((r) => r.length), messages.map((m) => m.length));
  assert.ok(received.every((r, i) => r === messages[i]));
  ws.close();
  await new Promise<void>((done) => server.close(() => done()));
});

/** Minimal client-side framing, to test what browsers don't normally send. */
function frame(opcode: number, payload: Buffer, { fin = true, masked = true } = {}): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const len = payload.length;
  const header = Buffer.alloc(len < 126 ? 2 : 4);
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = (masked ? 0x80 : 0) | (len < 126 ? len : 126);
  if (len >= 126) header.writeUInt16BE(len, 2);
  const body = Buffer.from(payload);
  if (masked) for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([header, masked ? mask : Buffer.alloc(0), body]);
}

/** Opens a raw TCP connection to the game server and does the WebSocket handshake by hand. */
async function rawSocket(port: number): Promise<{ socket: Socket; handshake: string; frames: { opcode: number; payload: Buffer }[]; closed: Promise<void> }> {
  const socket = connect(port, '127.0.0.1');
  let buffer = Buffer.alloc(0);
  let handshake = '';
  const frames: { opcode: number; payload: Buffer }[] = [];
  const closed = new Promise<void>((done) => socket.on('close', () => done()));
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshake) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      handshake = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 4);
    }
    while (buffer.length >= 2) {
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (buffer.length < offset + len) return;
      frames.push({ opcode: buffer[0] & 0x0f, payload: Buffer.from(buffer.subarray(offset, offset + len)) });
      buffer = buffer.subarray(offset + len);
    }
  });
  socket.write(
    'GET /api/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
  );
  await until(() => handshake !== '', 'handshake');
  return { socket, handshake, frames, closed };
}

test('WebSocket protocol: handshake, fragments, ping/pong, close, and rule breaking', async () => {
  const { gs, port } = await startServer();
  try {
    const a = await rawSocket(port);
    assert.match(a.handshake, /^HTTP\/1\.1 101/);
    assert.match(a.handshake, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/); // the example from RFC 6455
    // A message split into two frames.
    a.socket.write(frame(0x1, Buffer.from('{"type":'), { fin: false }));
    a.socket.write(frame(0x0, Buffer.from('"ping"}')));
    a.socket.write(frame(0x9, Buffer.from('are you there'))); // ping
    await until(() => a.frames.length >= 2, 'pong replies');
    assert.deepEqual(a.frames.map((f) => [f.opcode, f.payload.toString('utf8')]), [[0x1, '{"type":"pong"}'], [0xa, 'are you there']]);
    const closeFrame = Buffer.alloc(2);
    closeFrame.writeUInt16BE(1000, 0);
    a.socket.write(frame(0x8, closeFrame));
    await a.closed;
    assert.equal(a.frames[a.frames.length - 1].opcode, 0x8);

    // Clients must mask their frames: the server closes with 1002 (protocol error).
    const b = await rawSocket(port);
    b.socket.write(frame(0x1, Buffer.from('{"type":"ping"}'), { masked: false }));
    await b.closed;
    assert.equal(b.frames[0].opcode, 0x8);
    assert.equal(b.frames[0].payload.readUInt16BE(0), 1002);

    // A message whose fragments add up to more than 64 KB: closed with 1009 (too big).
    const c = await rawSocket(port);
    c.socket.write(frame(0x1, Buffer.from('x'.repeat(65_535)), { fin: false }));
    c.socket.write(frame(0x0, Buffer.from('x'.repeat(65_535)), { fin: false }));
    await c.closed;
    assert.deepEqual(c.frames.map((f) => [f.opcode, f.payload.readUInt16BE(0)]), [[0x8, 1009]]);

    // Something that isn't a game message at all: closed with 4000.
    const d = await rawSocket(port);
    d.socket.write(frame(0x1, Buffer.from('hello?')));
    await d.closed;
    assert.deepEqual(d.frames.map((f) => [f.opcode, f.payload.readUInt16BE(0)]), [[0x8, 4000]]);
  } finally {
    await gs.stop();
  }
});
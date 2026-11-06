// A small WebSocket server (RFC 6455) built on plain Node.js, so the game needs no packages.
// Supports what browsers need: text messages (also when split into fragments), ping/pong, and closing.
// Not supported (not needed here): binary messages, compression, subprotocols.
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface WebSocketConnection {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  isOpen(): boolean;
  /** Set these after accepting. */
  onMessage: (text: string) => void;
  onClose: (code: number) => void;
}

export interface AcceptOptions {
  /** Largest message a client may send. Default 64 KB. */
  maxMessageBytes?: number;
  /** How often to ping the client; a client that misses two pings is dropped. Default 30 s. 0 = never. */
  pingIntervalMs?: number;
}

/** Lets Node exit even if this timer is still waiting. */
function unref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

/** Completes the WebSocket handshake for an HTTP 'upgrade' request. Returns null if the request isn't valid. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, opts: AcceptOptions = {}): WebSocketConnection | null {
  const maxBytes = opts.maxMessageBytes ?? 64 * 1024;
  const pingMs = opts.pingIntervalMs ?? 30_000;
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + HANDSHAKE_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let open = true; // false once we've sent or received a close frame
  let notified = false;
  let closeCode = 1006; // "closed abnormally" unless a close frame says otherwise
  let alive = true;
  let buffer: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let inMessage = false;

  const conn: WebSocketConnection = {
    send(text) {
      if (open) writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
    },
    close(code = 1000, reason = '') {
      if (!open) return;
      open = false;
      closeCode = code;
      const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
      const payload = Buffer.alloc(2 + reasonBytes.length);
      payload.writeUInt16BE(code, 0);
      reasonBytes.copy(payload, 2);
      writeFrame(OP_CLOSE, payload, true);
      socket.end();
      unref(setTimeout(() => socket.destroy(), 2000));
    },
    isOpen: () => open,
    onMessage: () => {},
    onClose: () => {},
  };

  function writeFrame(opcode: number, payload: Buffer, force = false): void {
    if ((!open && !force) || !socket.writable) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN + opcode; servers never mask
    socket.write(Buffer.concat([header, payload]));
  }

  function fail(code: number): void {
    conn.close(code);
    socket.destroy();
  }

  function parse(): void {
    while (open) {
      if (buffer.length < 2) return;
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if ((b0 & 0x70) !== 0) return fail(1002); // reserved bits (no extensions were agreed)
      if ((b1 & 0x80) === 0) return fail(1002); // browsers must mask what they send
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(maxBytes)) return fail(1009);
        len = Number(big);
        offset = 10;
      }
      if (len > maxBytes) return fail(1009);
      if (buffer.length < offset + 4 + len) return; // wait for the rest of the frame
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + 4 + len);

      if (opcode >= 0x8) {
        // Control frames: never fragmented, at most 125 bytes.
        if (!fin || len > 125) return fail(1002);
        if (opcode === OP_CLOSE) {
          const code = len >= 2 ? payload.readUInt16BE(0) : 1005;
          const valid = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
          closeCode = code;
          writeFrame(OP_CLOSE, valid ? payload.subarray(0, 2) : Buffer.alloc(0), true);
          open = false;
          socket.end();
          return;
        }
        if (opcode === OP_PING) writeFrame(OP_PONG, payload);
        else if (opcode !== OP_PONG) return fail(1002);
        continue;
      }

      if (opcode === OP_CONTINUATION) {
        if (!inMessage) return fail(1002);
      } else {
        if (inMessage) return fail(1002);
        if (opcode !== OP_TEXT) return fail(1003); // binary messages aren't used
        inMessage = true;
      }
      fragments.push(payload);
      fragmentBytes += len;
      if (fragmentBytes > maxBytes) return fail(1009);
      if (fin) {
        const text = Buffer.concat(fragments).toString('utf8');
        fragments = [];
        fragmentBytes = 0;
        inMessage = false;
        try {
          conn.onMessage(text);
        } catch (err) {
          console.error('WebSocket message handler failed:', err);
        }
      }
    }
  }

  const pinger =
    pingMs > 0
      ? setInterval(() => {
          if (!alive) return fail(1001); // no answer since the last ping: the connection is dead
          alive = false;
          writeFrame(OP_PING, Buffer.alloc(0));
        }, pingMs)
      : null;
  if (pinger) unref(pinger);

  socket.on('data', (chunk: Buffer) => {
    alive = true;
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
    parse();
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    open = false;
    if (pinger) clearInterval(pinger);
    if (notified) return;
    notified = true;
    conn.onClose(closeCode);
  });
  if (buffer.length > 0) queueMicrotask(parse); // data that arrived with the handshake
  return conn;
}
// Starts the Dividend Drive game server: the game itself, plus online rooms.
//
//   npm run server                     builds the game, then serves it at http://localhost:8080
//   $env:PORT=3000; npm run server     (PowerShell) use a different port
//
// Rooms live in memory: they close when you stop the server.
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../src/server/http.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');
if (!existsSync(join(webDir, 'dist', 'ui', 'main.js'))) {
  console.error('The game is not built yet. Run "npm run server" (it builds first) or "npm run build:web".');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';
const { server, stop } = createGameServer({ webDir });

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Is the server already running in another window?`);
  else console.error(err);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log('Dividend Drive server is running.');
  console.log(`  On this computer:   http://localhost:${port}`);
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) console.log(`  On your network:    http://${net.address}:${port}`);
    }
  }
  console.log('Press Ctrl+C to stop. (Open rooms close when the server stops.)');
});

const shutdown = () => {
  console.log('\nStopping...');
  stop().then(() => process.exit(0));
  (setTimeout(() => process.exit(0), 3000) as { unref?: () => void }).unref?.();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
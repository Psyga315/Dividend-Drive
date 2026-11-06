// Development server: builds the game, serves it at http://127.0.0.1:5173 with online rooms,
// and rebuilds + reloads the browser whenever you save a file. No extra packages needed.
//
//   npm run dev                           start (opens your browser on Windows/macOS)
//   node scripts/dev-server.mjs --no-open start without opening the browser
//   different port (PowerShell):          $env:PORT=8080; npm run dev
//
// Try online play by opening the page in two browser windows (one normal, one private).
// Changes to the server code itself (src/server/) need a restart: Ctrl+C, then npm run dev.
import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer } from '../src/server/http.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'web');
const srcDir = join(root, 'src');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const port = Number(process.env.PORT ?? 5173);
const host = '127.0.0.1'; // this computer only, so Windows Firewall doesn't ask for permission
const url = `http://${host}:${port}`;

if (!existsSync(tsc)) {
  console.error('TypeScript is not installed yet. Run "npm install" first.');
  process.exit(1);
}

const { server, reload } = createGameServer({ webDir, liveReload: true });

// ---------- Building ----------

let building = false;
let buildAgain = false;

/** Compiles src/ into web/dist/. Type errors are printed but the game still builds. */
function build() {
  if (building) {
    buildAgain = true;
    return;
  }
  building = true;
  const started = Date.now();
  const child = spawn(process.execPath, [tsc, '-p', 'tsconfig.web.json', '--pretty'], { cwd: root, stdio: 'inherit' });
  child.on('exit', (code) => {
    building = false;
    const time = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    if (code === 0) console.log(`[dev] Built in ${time}. Open ${url}`);
    else console.log(`[dev] Built in ${time} WITH ERRORS (above). The game may not work until they're fixed.`);
    reload();
    if (buildAgain) {
      buildAgain = false;
      build();
    }
  });
}

/** Calls fn once things go quiet for a moment (editors often save in several steps). */
function debounce(fn, ms = 150) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

const debouncedReload = debounce(reload);
const debouncedBuild = debounce(build);
watch(srcDir, { recursive: true }, (_event, file) => {
  if (file && String(file).replace(/\\/g, '/').startsWith('server/')) {
    console.log('[dev] Server code changed: restart "npm run dev" to use it.');
  }
  debouncedBuild();
});
watch(webDir, { recursive: true }, (_event, file) => {
  // web/dist changes come from our own builds, which already trigger a reload.
  if (file && !String(file).startsWith('dist')) debouncedReload();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[dev] Port ${port} is busy. Is the game already running in another terminal? Close it, or pick another port.`);
  else console.error(err);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`[dev] Game running at ${url}  (press Ctrl+C to stop)`);
  build();
  if (!process.argv.includes('--no-open')) openBrowser();
});

function openBrowser() {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Not important: the URL is printed above.
  }
}
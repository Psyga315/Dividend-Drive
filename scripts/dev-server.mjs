// Development server: builds the game, serves it at http://127.0.0.1:5173, and rebuilds +
// reloads the browser whenever you save a file. No extra packages needed.
//
//   npm run dev                          start (opens your browser on Windows/macOS)
//   node scripts/dev-server.mjs --no-open start without opening the browser
//   different port (PowerShell):         $env:PORT=8080; npm run dev
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync, watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    if (code === 0) console.log(`[dev] Built in ${time}. ${clients.size ? 'Reloading the browser.' : `Open ${url}`}`);
    else console.log(`[dev] Built in ${time} WITH ERRORS (above). The game may not work until they're fixed.`);
    reloadBrowsers();
    if (buildAgain) {
      buildAgain = false;
      build();
    }
  });
}

// ---------- Live reload ----------

const clients = new Set();
const RELOAD_SNIPPET = `<script>new EventSource('/__reload').onmessage = () => location.reload();</script>`;

function reloadBrowsers() {
  for (const res of clients) res.write('data: reload\n\n');
}

/** Calls fn once things go quiet for a moment (editors often save in several steps). */
function debounce(fn, ms = 150) {
  let timer;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

watch(srcDir, { recursive: true }, debounce(build));
watch(webDir, { recursive: true }, (_event, file) => {
  // web/dist changes come from our own builds, which already trigger a reload.
  if (file && !String(file).startsWith('dist')) debouncedReload();
});
const debouncedReload = debounce(reloadBrowsers);

// ---------- Serving files ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', url).pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (path === '/__reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const file = normalize(join(webDir, path === '/' ? 'index.html' : path));
  if (relative(webDir, file).startsWith('..') || file.includes(`${sep}..${sep}`) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${path}`);
    return;
  }
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  if (extname(file) === '.html') {
    const html = await readFile(file, 'utf8');
    res.end(html.replace('</body>', `${RELOAD_SNIPPET}</body>`));
  } else {
    createReadStream(file).pipe(res);
  }
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
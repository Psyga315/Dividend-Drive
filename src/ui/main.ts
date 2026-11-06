// Browser entry point: connects the screen to the game. Two modes:
//   local:  the whole game runs in this tab (bots and every human at this computer)
//   online: the game runs on the game server; this tab plays one seat
import type { ActionBody } from '../engine/index.ts';
import { STALE, normalizeCode, type Command, type RoomOptions, type RoomView } from '../online/protocol.ts';
import {
  applyAction, botStep, clickSquare, fromSave, isBotTurn, resolveSquareClick, startGame, toSave,
  type AppState, type BotKind, type Seat, type SeatKind,
} from './app.ts';
import { clampAmount, withAmount, type AmountField, type UiCommand } from './html.ts';
import { renderConnecting, renderLobby, renderOnlineHome } from './lobby-view.ts';
import { OnlineClient, createRoom, joinRoom, normalizeServer, serverAvailable, type Session } from './online.ts';
import { safeStorage } from './storage.ts';
import { renderGame, renderSetup } from './view.ts';

const SAVE_KEY = 'stock-board-game/save-v1';
const SPEED_KEY = 'stock-board-game/speed';
const NAME_KEY = 'dividend-drive/name';
const SESSION_KEY = 'dividend-drive/online-session';

// Never touch window.localStorage directly: some browsers block it, and then even reading it throws.
const { storage, persistent } = safeStorage(() => window.localStorage);
if (!persistent) console.warn('This browser blocks storage here, so the game will not be saved between visits.');

const root = document.getElementById('app')!;

// ---------- Local play ----------

let localApp: AppState | null = fromSave(storage.getItem(SAVE_KEY));
let speedMs = Number(storage.getItem(SPEED_KEY) ?? 600);
let botTimer: ReturnType<typeof setTimeout> | undefined;

// ---------- Online play ----------

const params = new URLSearchParams(location.search);
/** Where the game server is: this page's own site, unless the link says ?server=... */
const serverUrl = normalizeServer(params.get('server') || location.origin);
let mode: 'local' | 'online' = params.has('room') ? 'online' : 'local';
let serverOk: boolean | null = null;
let client: OnlineClient | null = null;
let homeMessage: string | null = null;
let homeCode = normalizeCode(params.get('room'));
let busy = false;
const ui = { selected: null as number | null, routeFor: null as number | null, error: null as string | null, copied: false };
let lastStep = -1;

function savedSession(): Session | null {
  try {
    const s = JSON.parse(storage.getItem(SESSION_KEY) ?? 'null') as Session | null;
    return s && s.server === serverUrl && typeof s.code === 'string' && typeof s.token === 'string' ? s : null;
  } catch {
    return null;
  }
}

// ---------- Rendering ----------

function screenHtml(): string {
  if (mode === 'local') return localApp ? renderGame(localApp, { speedMs }) : renderSetup();
  if (!client) {
    return renderOnlineHome({
      serverOk,
      name: storage.getItem(NAME_KEY) ?? '',
      code: homeCode,
      message: homeMessage,
      busy,
      savedRoom: savedSession()?.code ?? null,
    });
  }
  const view = client.view;
  if (!view) return renderConnecting(client.status);
  if (!view.game) return renderLobby(view, { inviteUrl: inviteUrl(view.code), status: client.status, copied: ui.copied, error: ui.error });
  return renderGame(onlineApp(view), { speedMs, online: { code: view.code, status: client.status, seats: view.seats } });
}

/** The online game as the shared game screen expects it. */
function onlineApp(view: RoomView): AppState {
  return {
    seats: view.seats.map((s) => ({ name: s.name, kind: s.kind })),
    game: view.game!,
    log: view.log,
    selected: ui.selected,
    routeFor: ui.routeFor,
    error: ui.error,
    viewer: view.you,
  };
}

function render(): void {
  const logScroll = root.querySelector('.log')?.scrollTop ?? 0;
  const kept = rememberInputs();
  root.innerHTML = screenHtml();
  restoreInputs(kept);
  const log = root.querySelector('.log');
  if (log) log.scrollTop = logScroll;
}

/** Online, the screen redraws when other players connect or move; keep what you were typing. */
function rememberInputs() {
  const values = new Map<string, { value: string; checked: boolean; min: string; max: string }>();
  for (const el of root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input[id], select[id]')) {
    const input = el as HTMLInputElement;
    values.set(el.id, { value: el.value, checked: input.checked, min: input.min ?? '', max: input.max ?? '' });
  }
  const active = document.activeElement;
  return { values, focus: active && root.contains(active) && active.id ? active.id : null };
}

function restoreInputs(kept: ReturnType<typeof rememberInputs>): void {
  for (const [id, old] of kept.values) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el || el.readOnly || el.disabled) continue;
    if (el.type === 'checkbox') el.checked = old.checked;
    else if (el.type !== 'number' || (el.min === old.min && el.max === old.max)) el.value = old.value; // range unchanged
  }
  if (kept.focus) document.getElementById(kept.focus)?.focus();
}

// ---------- Local game ----------

function updateLocal(next: AppState | null): void {
  localApp = next;
  if (localApp) storage.setItem(SAVE_KEY, toSave(localApp));
  else storage.removeItem(SAVE_KEY);
  render();
  scheduleBot();
}

/** If a bot must act, let it act after a short pause so people can follow along. */
function scheduleBot(): void {
  if (mode !== 'local' || botTimer !== undefined || !localApp || !isBotTurn(localApp)) return;
  botTimer = setTimeout(() => {
    botTimer = undefined;
    if (mode === 'local' && localApp) guarded(() => updateLocal(botStep(localApp!)));
  }, speedMs);
}

function readSetup(): { seats: Seat[]; error?: string } {
  const seats: Seat[] = [];
  for (let i = 0; i < 4; i++) {
    const kind = (document.getElementById(`seat-kind-${i}`) as HTMLSelectElement).value;
    if (kind === 'none') continue;
    const name = (document.getElementById(`seat-name-${i}`) as HTMLInputElement).value;
    seats.push({ name, kind: kind as SeatKind });
  }
  if (seats.length < 2) return { seats, error: 'A game needs at least 2 players.' };
  return { seats };
}

// ---------- Online ----------

function inviteUrl(code: string): string {
  const extra = serverUrl === normalizeServer(location.origin) ? '' : `&server=${encodeURIComponent(serverUrl)}`;
  return `${location.origin}${location.pathname}?room=${code}${extra}`;
}

/** Keeps the address bar in sync, so refreshing the page brings you back to the same room. */
function setAddress(code: string | null): void {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

function goOnline(): void {
  mode = 'online';
  render();
  if (serverOk === null) {
    serverAvailable(serverUrl).then((ok) => {
      serverOk = ok;
      render();
    });
  }
}

function startSession(session: Session): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
  client?.close();
  busy = false;
  homeMessage = null;
  Object.assign(ui, { selected: null, routeFor: null, error: null, copied: false });
  lastStep = -1;
  client = new OnlineClient(session, {
    onView: (view) => {
      if (view.step !== lastStep) ui.routeFor = null; // a route picked on an old screen no longer applies
      lastStep = view.step;
      render();
    },
    onStatus: () => render(),
    onEnded: (_reason, message) => {
      storage.removeItem(SESSION_KEY);
      client = null;
      homeMessage = message;
      setAddress(null);
      render();
    },
  });
  setAddress(session.code);
  client.connect();
  render();
}

function yourName(): string | null {
  const input = document.getElementById('online-name') as HTMLInputElement | null;
  const name = (input?.value ?? '').trim();
  if (!name) {
    homeMessage = 'Enter your name first.';
    render();
    document.getElementById('online-name')?.focus();
    return null;
  }
  storage.setItem(NAME_KEY, name);
  return name;
}

function withServer(task: () => Promise<Session>): void {
  busy = true;
  homeMessage = null;
  render();
  task()
    .then(startSession)
    .catch((err: unknown) => {
      busy = false;
      homeMessage = err instanceof Error ? err.message : String(err);
      render();
    });
}

/** Sends a command to the server; shows its error message if it's refused. */
function send(command: Command): void {
  if (!client) return;
  ui.error = null;
  client.command(command).then((result) => {
    if (!result.ok && result.error !== STALE) {
      ui.error = result.error;
      render();
    }
  });
}

function sendMove(action: ActionBody): void {
  if (!client?.view) return;
  ui.routeFor = null;
  ui.error = null;
  client.act(action).then((result) => {
    if (!result.ok && result.error !== STALE) {
      ui.error = result.error;
      render();
    }
  });
}

function copyInvite(): void {
  const input = document.getElementById('invite-link') as HTMLInputElement | null;
  if (!input) return;
  const done = () => {
    ui.copied = true;
    render();
    setTimeout(() => {
      ui.copied = false;
      render();
    }, 2000);
  };
  const fallback = () => {
    // The clipboard API only works on https:// or localhost pages.
    input.select();
    if (document.execCommand('copy')) done();
    else ui.error = 'Select the link and press Ctrl+C to copy it.';
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(input.value).then(done, fallback);
  else fallback();
}

// ---------- Buttons ----------

function readAction(el: HTMLElement): ActionBody {
  const body = JSON.parse(el.dataset.act!) as ActionBody;
  const inputId = el.dataset.input;
  if (!inputId) return body;
  const input = document.getElementById(inputId) as HTMLInputElement;
  return withAmount(body, el.dataset.field as AmountField, clampAmount(input.value, Number(input.min), Number(input.max)));
}

function handleUi(cmd: UiCommand): void {
  switch (cmd.cmd) {
    // local
    case 'start': {
      const { seats, error } = readSetup();
      const box = document.getElementById('setup-error')!;
      if (error) {
        box.textContent = error;
        box.hidden = false;
        return;
      }
      const checked = (id: string) => (document.getElementById(id) as HTMLInputElement).checked;
      updateLocal(startGame({
        seats,
        target: Number((document.getElementById('opt-target') as HTMLSelectElement).value),
        randomOrder: checked('opt-random'),
        catchUpCash: checked('opt-catchup'),
        ventureCards: checked('opt-ventures'),
      }));
      return;
    }
    case 'newGame':
      if (localApp && localApp.game.phase.kind !== 'gameOver' && !confirm('Abandon this game and start a new one?')) return;
      if (botTimer !== undefined) clearTimeout(botTimer);
      botTimer = undefined;
      updateLocal(null);
      return;
    case 'square': {
      if (mode === 'local') {
        if (localApp) updateLocal(clickSquare(localApp, cmd.square));
        return;
      }
      const view = client?.view;
      if (!view?.game) return;
      const click = resolveSquareClick(onlineApp(view), cmd.square);
      if (click.kind === 'move') {
        ui.selected = cmd.square;
        sendMove({ type: 'move', path: click.path });
      } else {
        ui.selected = click.selected;
        ui.routeFor = click.routeFor;
      }
      render();
      return;
    }
    case 'dismissError':
      if (mode === 'local' && localApp) updateLocal({ ...localApp, error: null });
      else {
        ui.error = null;
        render();
      }
      return;
    // switching modes
    case 'goOnline':
      if (botTimer !== undefined) clearTimeout(botTimer);
      botTimer = undefined;
      goOnline();
      return;
    case 'goLocal':
      client?.close();
      client = null;
      mode = 'local';
      homeMessage = null;
      setAddress(null);
      render();
      scheduleBot();
      return;
    // online home
    case 'createRoom': {
      const name = yourName();
      if (name) withServer(() => createRoom(serverUrl, name));
      return;
    }
    case 'joinRoom': {
      const code = normalizeCode((document.getElementById('online-code') as HTMLInputElement | null)?.value);
      homeCode = code;
      if (!code) {
        homeMessage = 'Enter the room code your friend sent you.';
        render();
        return;
      }
      const saved = savedSession();
      if (saved && saved.code === code) return startSession(saved); // already have a seat there
      const name = yourName();
      if (name) withServer(() => joinRoom(serverUrl, code, name));
      return;
    }
    case 'rejoin': {
      const saved = savedSession();
      if (saved) startSession(saved);
      return;
    }
    case 'forgetRoom':
      storage.removeItem(SESSION_KEY);
      render();
      return;
    // lobby and online game
    case 'copyInvite':
      copyInvite();
      return;
    case 'leaveRoom':
      if (client?.view && !client.view.game) send({ type: 'leave' });
      return;
    case 'exitGame': {
      const running = client?.view?.game && client.view.game.phase.kind !== 'gameOver';
      if (running && !confirm('Leave this game? You can rejoin from "Play online" while the room is open. Until then, the others can let a bot play for you.')) return;
      client?.close();
      client = null;
      setAddress(null);
      render();
      return;
    }
    case 'addBot': {
      const kind = (document.getElementById('bot-kind') as HTMLSelectElement | null)?.value as BotKind | undefined;
      send({ type: 'addBot', kind: kind ?? 'balanced' });
      return;
    }
    case 'removeSeat':
      send({ type: 'removeSeat', seat: cmd.seat });
      return;
    case 'startOnline':
      send({ type: 'start' });
      return;
    case 'standIn':
      send({ type: 'standIn', seat: cmd.seat });
      return;
    case 'backToLobby':
      send({ type: 'backToLobby' });
      return;
  }
}

/** Shows unexpected errors on screen instead of silently freezing. */
function guarded(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    showCrash(err);
  }
}

function showCrash(err: unknown): void {
  console.error(err);
  const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  let box = document.getElementById('crash');
  if (!box) {
    box = document.createElement('div');
    box.id = 'crash';
    document.body.appendChild(box);
  }
  box.innerHTML = '<b>Something went wrong.</b> Copy this text and send it to Claude:<pre></pre><button>Close</button>';
  box.querySelector('pre')!.textContent = msg;
  box.querySelector('button')!.addEventListener('click', () => box!.remove());
}

document.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-act],[data-ui]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  guarded(() => {
    if (el.dataset.ui) return handleUi(JSON.parse(el.dataset.ui) as UiCommand);
    const action = readAction(el);
    if (mode === 'online') return sendMove(action);
    if (localApp && !isBotTurn(localApp)) updateLocal(applyAction({ ...localApp, routeFor: null }, action));
  });
});

document.addEventListener('change', (e) => {
  const el = e.target as HTMLElement;
  if (el.id === 'speed') {
    speedMs = Number((el as HTMLSelectElement).value);
    storage.setItem(SPEED_KEY, String(speedMs));
    return;
  }
  // Lobby options (host only). The server sends everyone the new settings.
  const key = el.dataset.roomOption as keyof RoomOptions | undefined;
  if (!key) return;
  const input = el as HTMLInputElement;
  const value = input.type === 'checkbox' ? input.checked : key === 'target' ? Number(input.value) : input.value;
  guarded(() => send({ type: 'setOptions', options: { [key]: value } }));
});

// Enter in a text or number box clicks the button that goes with it.
document.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement;
  if (e.key !== 'Enter' || !(el instanceof HTMLInputElement)) return;
  if (el.type === 'number') document.querySelector<HTMLElement>(`[data-input="${CSS.escape(el.id)}"]`)?.click();
  else if (el.id === 'online-code') guarded(() => handleUi({ cmd: 'joinRoom' }));
});

window.addEventListener('error', (e) => showCrash(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showCrash(e.reason));

guarded(() => {
  if (mode === 'online') {
    const saved = savedSession();
    if (saved && saved.code === homeCode) startSession(saved); // reopened the page or the invite link: reconnect
    else goOnline();
  } else {
    render();
    scheduleBot();
  }
});
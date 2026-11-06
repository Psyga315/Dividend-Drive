// Browser entry point: connects the screen to the app state. All game logic lives elsewhere.
import { botStep, clickSquare, applyAction, fromSave, isBotTurn, startGame, toSave, type AppState, type Seat, type SeatKind } from './app.ts';
import { clampAmount, withAmount, type AmountField, type UiCommand } from './html.ts';
import { renderGame, renderSetup } from './view.ts';
import type { ActionBody } from '../engine/index.ts';

const SAVE_KEY = 'stock-board-game/save-v1';
const SPEED_KEY = 'stock-board-game/speed';

const root = document.getElementById('app')!;
let app: AppState | null = fromSave(localStorage.getItem(SAVE_KEY));
let speedMs = Number(localStorage.getItem(SPEED_KEY) ?? 600);
let botTimer: ReturnType<typeof setTimeout> | undefined;

function render(): void {
  const logScroll = root.querySelector('.log')?.scrollTop ?? 0;
  root.innerHTML = app ? renderGame(app, { speedMs }) : renderSetup();
  const log = root.querySelector('.log');
  if (log) log.scrollTop = logScroll;
}

function update(next: AppState | null): void {
  app = next;
  if (app) localStorage.setItem(SAVE_KEY, toSave(app));
  else localStorage.removeItem(SAVE_KEY);
  render();
  scheduleBot();
}

/** If a bot must act, let it act after a short pause so people can follow along. */
function scheduleBot(): void {
  if (botTimer !== undefined || !app || !isBotTurn(app)) return;
  botTimer = setTimeout(() => {
    botTimer = undefined;
    if (app) guarded(() => update(botStep(app!)));
  }, speedMs);
}

function readAction(el: HTMLElement): ActionBody {
  const body = JSON.parse(el.dataset.act!) as ActionBody;
  const inputId = el.dataset.input;
  if (!inputId) return body;
  const input = document.getElementById(inputId) as HTMLInputElement;
  return withAmount(body, el.dataset.field as AmountField, clampAmount(input.value, Number(input.min), Number(input.max)));
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

function handleUi(cmd: UiCommand): void {
  switch (cmd.cmd) {
    case 'start': {
      const { seats, error } = readSetup();
      const box = document.getElementById('setup-error')!;
      if (error) {
        box.textContent = error;
        box.hidden = false;
        return;
      }
      const checked = (id: string) => (document.getElementById(id) as HTMLInputElement).checked;
      update(startGame({
        seats,
        target: Number((document.getElementById('opt-target') as HTMLSelectElement).value),
        randomOrder: checked('opt-random'),
        catchUpCash: checked('opt-catchup'),
        ventureCards: checked('opt-ventures'),
      }));
      return;
    }
    case 'newGame':
      if (app && app.game.phase.kind !== 'gameOver' && !confirm('Abandon this game and start a new one?')) return;
      if (botTimer !== undefined) clearTimeout(botTimer);
      botTimer = undefined;
      update(null);
      return;
    case 'square':
      if (app) update(clickSquare(app, cmd.square));
      return;
    case 'dismissError':
      if (app) update({ ...app, error: null });
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
  if (!el) return;
  guarded(() => {
    if (el.dataset.ui) return handleUi(JSON.parse(el.dataset.ui) as UiCommand);
    if (app && !isBotTurn(app)) update(applyAction({ ...app, routeFor: null }, readAction(el)));
  });
});

document.addEventListener('change', (e) => {
  const el = e.target as HTMLElement;
  if (el.id === 'speed') {
    speedMs = Number((el as HTMLSelectElement).value);
    localStorage.setItem(SPEED_KEY, String(speedMs));
  }
});

// Enter in a number box clicks its button.
document.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement;
  if (e.key !== 'Enter' || !(el instanceof HTMLInputElement) || el.type !== 'number') return;
  document.querySelector<HTMLElement>(`[data-input="${CSS.escape(el.id)}"]`)?.click();
});

window.addEventListener('error', (e) => showCrash(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showCrash(e.reason));

guarded(() => {
  render();
  scheduleBot();
});
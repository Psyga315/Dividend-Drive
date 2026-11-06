// Small helpers for building HTML strings safely.
import type { ActionBody, SquareId } from '../engine/index.ts';

/** Escape text for use inside HTML (player names come from the user, so always escape them). */
export function esc(text: string | number): string {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Commands handled by the UI itself rather than the rules engine. */
export type UiCommand =
  | { cmd: 'square'; square: SquareId } // clicked a board square
  | { cmd: 'start' } // setup screen: start the game
  | { cmd: 'newGame' } // game screen: back to setup
  | { cmd: 'dismissError' };

/** Field that a number input fills in, for actions with an amount. */
export type AmountField = 'qty' | 'amount';

/**
 * Marks an element as a game action. If `input` is given, the action's amount is read from that
 * <input> when clicked (the value in `body` is a placeholder).
 */
export function actAttr(body: ActionBody, input?: { id: string; field: AmountField }): string {
  const extra = input ? ` data-input="${esc(input.id)}" data-field="${input.field}"` : '';
  return `data-act="${esc(JSON.stringify(body))}"${extra}`;
}

export function uiAttr(command: UiCommand): string {
  return `data-ui="${esc(JSON.stringify(command))}"`;
}

export function numberInput(id: string, min: number, max: number, value: number): string {
  return `<input id="${esc(id)}" class="num" type="number" min="${min}" max="${max}" step="1" value="${Math.min(max, Math.max(min, value))}">`;
}

/** Turns whatever was typed into a whole number within [min, max]. */
export function clampAmount(raw: string, min: number, max: number): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Copies `body` with its amount field set (used when an action button is clicked). */
export function withAmount(body: ActionBody, field: AmountField, value: number): ActionBody {
  return { ...body, [field]: value } as ActionBody;
}
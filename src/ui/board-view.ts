// Draws the board as an SVG string.
import { indexBoard, shopFee, type GameState, type SquareDef, type SquareId } from '../engine/index.ts';
import { SUIT_SYMBOLS } from '../describe.ts';
import { esc, uiAttr } from './html.ts';

export const PLAYER_COLORS = ['#dc2626', '#2563eb', '#ca8a04', '#334155'];
const DISTRICT_COLORS = ['#0891b2', '#c026d3', '#65a30d', '#ea580c', '#7c3aed', '#be123c', '#0f766e', '#a16207'];

export function districtColor(s: GameState, district: string): string {
  const i = indexBoard(s.board).districts.indexOf(district);
  return DISTRICT_COLORS[(i < 0 ? 0 : i) % DISTRICT_COLORS.length];
}

const CELL = 100; // grid spacing in SVG units
const SIZE = 84; // square size
const PAD = 12;
const TOKEN_R = 11;
const TOKEN_GAP = 21; // distance between token slots

const center = (sq: SquareDef) => ({ x: PAD + sq.x * CELL + CELL / 2, y: PAD + sq.y * CELL + CELL / 2 });

export interface BoardOptions {
  /** Squares the current human player can move to (highlighted and clickable). */
  destinations: Set<SquareId>;
  selected: SquareId | null;
}

export function renderBoard(s: GameState, opts: BoardOptions): string {
  const b = indexBoard(s.board);
  const squares = s.board.squares;
  const width = PAD * 2 + (Math.max(...squares.map((q) => q.x)) + 1) * CELL;
  const height = PAD * 2 + (Math.max(...squares.map((q) => q.y)) + 1) * CELL;

  const links: string[] = [];
  for (const sq of squares) {
    for (const to of sq.links) {
      if (to < sq.id) continue; // draw each link once
      const a = center(sq);
      const c = center(b.byId.get(to)!);
      links.push(`<line x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}" class="link"/>`);
    }
  }

  const tiles = squares.map((sq) => renderSquare(s, sq, opts)).join('');

  // Player tokens sit on the bottom edge of their square, each player in a fixed slot,
  // so they never cover the square's text.
  const tokens: string[] = [];
  s.players.forEach((pl, i) => {
    if (pl.bankrupt) return;
    const c = center(b.byId.get(pl.position)!);
    const x = c.x + (i - (s.players.length - 1) / 2) * TOKEN_GAP;
    const y = c.y + SIZE / 2;
    const active = s.phase.kind !== 'gameOver' && s.turn.player === i;
    tokens.push(
      `<g class="token${active ? ' active' : ''}" transform="translate(${x},${y})">` +
        `<circle r="${TOKEN_R}" fill="${PLAYER_COLORS[i]}"/><text class="token-label" y="4.5">${i + 1}</text></g>`,
    );
  });

  return (
    `<svg class="board" viewBox="0 0 ${width} ${height}" role="img" aria-label="Game board">` +
    `<g>${links.join('')}</g><g>${tiles}</g><g class="tokens">${tokens.join('')}</g></svg>`
  );
}

function renderSquare(s: GameState, sq: SquareDef, opts: BoardOptions): string {
  const c = center(sq);
  const x = c.x - SIZE / 2;
  const y = c.y - SIZE / 2;
  const classes = ['sq', `sq-${sq.type}`];
  if (opts.destinations.has(sq.id)) classes.push('dest');
  if (opts.selected === sq.id) classes.push('selected');
  let fill = '#ffffff';
  let stroke = '#94a3b8';
  let body = '';
  const text = (ty: number, cls: string, content: string) => `<text x="${c.x}" y="${y + ty}" class="${cls}">${content}</text>`;

  switch (sq.type) {
    case 'shop': {
      const shop = s.shops[sq.id];
      stroke = districtColor(s, sq.district);
      const b = indexBoard(s.board);
      const label = sq.name ?? `${sq.district}${(b.districtShops.get(sq.district) ?? []).indexOf(sq.id) + 1}`;
      body += `<text x="${x + 8}" y="${y + 18}" class="t-district" fill="${stroke}">${esc(label)}</text>`;
      body += text(46, 't-value', `${shop.value}G`);
      if (shop.owner === null) {
        body += text(66, 't-small', 'for sale');
      } else {
        fill = tint(PLAYER_COLORS[shop.owner]);
        const closed = s.players[shop.owner].shopsClosed;
        body += text(66, 't-small', closed ? 'closed' : `fee ${shopFee(s, sq.id)}`);
        body += `<rect x="${x + SIZE - 22}" y="${y + 6}" width="16" height="16" rx="3" fill="${PLAYER_COLORS[shop.owner]}"/>`;
        body += `<text x="${x + SIZE - 14}" y="${y + 18.5}" class="t-owner">${shop.owner + 1}</text>`;
      }
      break;
    }
    case 'bank':
      fill = '#fde68a';
      stroke = '#b45309';
      body = text(48, 't-big', 'BANK');
      break;
    case 'suit': {
      const red = sq.suit === 'heart' || sq.suit === 'diamond';
      fill = '#f8fafc';
      body = `<text x="${c.x}" y="${c.y + 12}" class="t-suit" fill="${red ? '#dc2626' : '#0f172a'}">${SUIT_SYMBOLS[sq.suit]}</text>`;
      break;
    }
    case 'stockbroker':
      fill = '#dcfce7';
      stroke = '#15803d';
      body = text(38, 't-label', 'STOCK') + text(56, 't-label', 'BROKER');
      break;
    case 'takeABreak':
      fill = '#e0f2fe';
      stroke = '#0369a1';
      body = text(38, 't-label', 'TAKE A') + text(56, 't-label', 'BREAK');
      break;
    case 'venture':
      if (s.config.ventureCards) {
        fill = '#f3e8ff';
        stroke = '#7e22ce';
        body = text(54, 't-big', '?');
      } else {
        fill = '#f1f5f9';
        body = text(48, 't-small', '—');
      }
      break;
  }
  return (
    `<g class="${classes.join(' ')}" ${uiAttr({ cmd: 'square', square: sq.id })}>` +
    `<rect x="${x}" y="${y}" width="${SIZE}" height="${SIZE}" rx="10" fill="${fill}" stroke="${stroke}" class="tile"/>${body}</g>`
  );
}

/** A pale version of a player color, for shop backgrounds. */
function tint(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (v: number) => Math.round(v + (255 - v) * 0.78);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}
import type { BoardDef, DistrictId, ShopSquare, SquareDef, SquareId } from './types.ts';

export interface BoardIndex {
  byId: Map<SquareId, SquareDef>;
  bank: SquareId;
  shops: ShopSquare[];
  districts: DistrictId[]; // in order of first appearance on the board
  districtShops: Map<DistrictId, SquareId[]>;
}

const cache = new WeakMap<BoardDef, BoardIndex>();

/** Lookup tables for a board (cached per board object). */
export function indexBoard(board: BoardDef): BoardIndex {
  const hit = cache.get(board);
  if (hit) return hit;
  const byId = new Map<SquareId, SquareDef>();
  const shops: ShopSquare[] = [];
  const districtShops = new Map<DistrictId, SquareId[]>();
  let bank = -1;
  for (const sq of board.squares) {
    byId.set(sq.id, sq);
    if (sq.type === 'bank') bank = sq.id;
    if (sq.type === 'shop') {
      shops.push(sq);
      const list = districtShops.get(sq.district) ?? [];
      list.push(sq.id);
      districtShops.set(sq.district, list);
    }
  }
  const index: BoardIndex = { byId, bank, shops, districts: [...districtShops.keys()], districtShops };
  cache.set(board, index);
  return index;
}

export function square(b: BoardIndex, id: SquareId): SquareDef {
  const sq = b.byId.get(id);
  if (!sq) throw new Error(`No square with id ${id}`);
  return sq;
}

export function shopSquare(b: BoardIndex, id: SquareId): ShopSquare {
  const sq = square(b, id);
  if (sq.type !== 'shop') throw new Error(`Square ${id} is not a shop`);
  return sq;
}

/** Returns a list of problems; empty means the board is usable. */
export function validateBoard(board: BoardDef): string[] {
  const problems: string[] = [];
  const ids = new Set<SquareId>();
  for (const sq of board.squares) {
    if (ids.has(sq.id)) problems.push(`Duplicate square id ${sq.id}`);
    ids.add(sq.id);
  }
  const banks = board.squares.filter((sq) => sq.type === 'bank');
  if (banks.length !== 1) problems.push(`Board needs exactly 1 bank, found ${banks.length}`);
  const byId = new Map(board.squares.map((sq) => [sq.id, sq]));
  for (const sq of board.squares) {
    if (sq.links.length === 0) problems.push(`Square ${sq.id} has no links`);
    if (new Set(sq.links).size !== sq.links.length) problems.push(`Square ${sq.id} lists a link twice`);
    for (const to of sq.links) {
      const other = byId.get(to);
      if (!other) problems.push(`Square ${sq.id} links to missing square ${to}`);
      else if (!other.links.includes(sq.id)) problems.push(`Link ${sq.id}->${to} has no matching ${to}->${sq.id}`);
      if (to === sq.id) problems.push(`Square ${sq.id} links to itself`);
    }
    if (sq.type === 'shop') {
      if (!Number.isInteger(sq.baseValue) || sq.baseValue <= 0) problems.push(`Shop ${sq.id} needs a positive whole baseValue`);
      if (sq.baseFee !== undefined && (!Number.isInteger(sq.baseFee) || sq.baseFee < 0)) problems.push(`Shop ${sq.id} has a bad baseFee`);
    }
  }
  const sizes = new Map<DistrictId, number>();
  for (const sq of board.squares) if (sq.type === 'shop') sizes.set(sq.district, (sizes.get(sq.district) ?? 0) + 1);
  if (sizes.size === 0) problems.push('Board has no shops');
  for (const [d, n] of sizes) if (n > 8) problems.push(`District ${d} has ${n} shops (max 8)`);
  // every square reachable from the bank
  if (banks.length === 1 && problems.length === 0) {
    const seen = new Set<SquareId>([banks[0].id]);
    const queue = [banks[0].id];
    while (queue.length) for (const to of byId.get(queue.pop()!)!.links) if (!seen.has(to)) (seen.add(to), queue.push(to));
    if (seen.size !== board.squares.length) problems.push('Some squares cannot be reached from the bank');
  }
  return problems;
}

/** Squares you may step to next. No U-turns, unless it's a dead end. */
export function nextSquares(b: BoardIndex, at: SquareId, cameFrom: SquareId | null): SquareId[] {
  const links = square(b, at).links;
  if (cameFrom === null) return links;
  const forward = links.filter((id) => id !== cameFrom);
  return forward.length > 0 ? forward : links;
}

/**
 * Every legal path for a move of `steps` squares. A path stops early when it
 * enters the bank (the move pauses there, RULES.md §4.1 and §9).
 */
export function enumeratePaths(b: BoardIndex, start: SquareId, cameFrom: SquareId | null, steps: number): SquareId[][] {
  const out: SquareId[][] = [];
  const path: SquareId[] = [];
  const walk = (at: SquareId, prev: SquareId | null, left: number): void => {
    if (left === 0 || (path.length > 0 && at === b.bank)) {
      out.push([...path]);
      return;
    }
    for (const to of nextSquares(b, at, prev)) {
      path.push(to);
      walk(to, at, left - 1);
      path.pop();
    }
  };
  walk(start, cameFrom, steps);
  return out;
}
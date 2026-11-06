import type { BoardDef } from '../engine/types.ts';

/**
 * Starter board (RULES.md §14): a 9x6 loop with a shortcut down the middle.
 * Square 0 (bank) and square 13 are junctions. Districts: A bottom-left, B left/top,
 * C top-right, D right/bottom, E the shortcut (most expensive, used by both halves).
 * Suits: spade (3) and heart (10) on the left half, diamond (16) and club (22) on the right.
 * Venture squares are blank while venture cards are off.
 */
export const STARTER_BOARD: BoardDef = {
  name: 'Starter Board',
  squares: [
    { id: 0, type: 'bank', x: 4, y: 5, links: [1, 25, 29] },
    { id: 1, type: 'shop', district: 'A', baseValue: 100, x: 3, y: 5, links: [0, 2] },
    { id: 2, type: 'shop', district: 'A', baseValue: 120, x: 2, y: 5, links: [1, 3] },
    { id: 3, type: 'suit', suit: 'spade', x: 1, y: 5, links: [2, 4] },
    { id: 4, type: 'shop', district: 'A', baseValue: 160, x: 0, y: 5, links: [3, 5] },
    { id: 5, type: 'shop', district: 'A', baseValue: 180, x: 0, y: 4, links: [4, 6] },
    { id: 6, type: 'venture', x: 0, y: 3, links: [5, 7] },
    { id: 7, type: 'shop', district: 'B', baseValue: 150, x: 0, y: 2, links: [6, 8] },
    { id: 8, type: 'shop', district: 'B', baseValue: 180, x: 0, y: 1, links: [7, 9] },
    { id: 9, type: 'shop', district: 'B', baseValue: 220, x: 0, y: 0, links: [8, 10] },
    { id: 10, type: 'suit', suit: 'heart', x: 1, y: 0, links: [9, 11] },
    { id: 11, type: 'shop', district: 'B', baseValue: 250, x: 2, y: 0, links: [10, 12] },
    { id: 12, type: 'stockbroker', x: 3, y: 0, links: [11, 13] },
    { id: 13, type: 'venture', x: 4, y: 0, links: [12, 14, 26] },
    { id: 14, type: 'shop', district: 'C', baseValue: 200, x: 5, y: 0, links: [13, 15] },
    { id: 15, type: 'shop', district: 'C', baseValue: 230, x: 6, y: 0, links: [14, 16] },
    { id: 16, type: 'suit', suit: 'diamond', x: 7, y: 0, links: [15, 17] },
    { id: 17, type: 'shop', district: 'C', baseValue: 260, x: 8, y: 0, links: [16, 18] },
    { id: 18, type: 'shop', district: 'C', baseValue: 310, x: 8, y: 1, links: [17, 19] },
    { id: 19, type: 'venture', x: 8, y: 2, links: [18, 20] },
    { id: 20, type: 'shop', district: 'D', baseValue: 240, x: 8, y: 3, links: [19, 21] },
    { id: 21, type: 'shop', district: 'D', baseValue: 280, x: 8, y: 4, links: [20, 22] },
    { id: 22, type: 'suit', suit: 'club', x: 8, y: 5, links: [21, 23] },
    { id: 23, type: 'shop', district: 'D', baseValue: 320, x: 7, y: 5, links: [22, 24] },
    { id: 24, type: 'shop', district: 'D', baseValue: 360, x: 6, y: 5, links: [23, 25] },
    { id: 25, type: 'takeABreak', x: 5, y: 5, links: [0, 24] },
    { id: 26, type: 'shop', district: 'E', baseValue: 300, x: 4, y: 1, links: [13, 27] },
    { id: 27, type: 'shop', district: 'E', baseValue: 350, x: 4, y: 2, links: [26, 28] },
    { id: 28, type: 'shop', district: 'E', baseValue: 420, x: 4, y: 3, links: [27, 29] },
    { id: 29, type: 'shop', district: 'E', baseValue: 530, x: 4, y: 4, links: [0, 28] },
  ],
};
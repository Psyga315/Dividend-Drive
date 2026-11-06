// Venture card texts (RULES.md §12). Effects are in engine.ts → applyCard().
export const VENTURE_CARDS: Readonly<Record<number, string>> = {
  1: 'Stock prices rise 10% in a random district.',
  2: 'Stock prices rise 20% in a random district.',
  3: 'Stock prices fall 10% in a random district.',
  4: 'Stock prices fall 20% in a random district.',
  5: 'Stock prices rise 20% in a district of your choice.',
  6: 'Receive 20 free shares in a random district.',
  7: 'Receive 5 free shares in every district.',
  8: 'Receive cash worth 10% of your stock value.',
  9: 'Buy stocks now.',
  10: 'Buy stocks now at 10% off.',
  11: 'Sell stocks now at 20% above market price.',
  12: 'Pay 2 for every share you own.',
  13: 'All shop values in a random district rise 10%.',
  14: 'All shop values in a random district fall 10%.',
  15: 'Invest in any of your shops now.',
  16: 'Roll the die and receive 50 × the roll.',
  17: 'Lose 10% of your cash.',
  18: 'Receive a Suit Yourself card (or 100 if you already hold the maximum).',
  19: 'Move in any direction next turn.',
  20: 'Receive half your salary.',
};

export const VENTURE_CARD_IDS: readonly number[] = Object.keys(VENTURE_CARDS).map(Number);
// Picks any legal action at random. Useful for stress tests and as a weak opponent.
import type { ActionBody, ActionPrompt } from '../engine/index.ts';
import type { Bot } from './bot.ts';

export function randomAction(prompt: ActionPrompt, rand: () => number): ActionBody {
  const ch = prompt.choices[Math.floor(rand() * prompt.choices.length)];
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  switch (ch.type) {
    case 'move': return { type: 'move', path: ch.path };
    case 'sellStock': return { type: 'sellStock', district: ch.district, qty: between(1, ch.maxQty) };
    case 'buyStock': return { type: 'buyStock', district: ch.district, qty: between(1, ch.maxQty) };
    case 'invest': return { type: 'invest', square: ch.square, amount: between(1, ch.maxAmount) };
    case 'chooseDistrict': return { type: 'chooseDistrict', district: ch.district };
    case 'sellShop': return { type: 'sellShop', square: ch.square };
    case 'bid': return { type: 'bid', amount: between(ch.min, ch.max) };
    default: return { type: ch.type };
  }
}

export function randomBot(name = 'random'): Bot {
  return { name, chooseAction: (_state, prompt, rand) => randomAction(prompt, rand) };
}
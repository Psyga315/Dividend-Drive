// Seeded random numbers (mulberry32). The generator state lives in GameState.rng,
// so the same seed + the same actions always replay the same game.

function next(seed: number): [value: number, seed: number] {
  const s = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), s | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

/** Random float in [0, 1). Advances holder.rng. */
export function random(holder: { rng: number }): number {
  const [value, seed] = next(holder.rng);
  holder.rng = seed;
  return value;
}

/** Random integer in [0, n). */
export function randInt(holder: { rng: number }, n: number): number {
  return Math.floor(random(holder) * n);
}

/** Fisher-Yates shuffle in place. */
export function shuffle<T>(holder: { rng: number }, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randInt(holder, i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Standalone generator, e.g. for bots and tests. */
export function makeRandom(seed: number): () => number {
  const holder = { rng: seed | 0 };
  return () => random(holder);
}
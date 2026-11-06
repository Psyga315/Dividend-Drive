// Browser storage that can't crash the game.
// Some browsers refuse storage to pages embedded in another site, or in some private windows; even
// *reading* window.localStorage then throws. The game still works; it just can't keep a save.

export interface SimpleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SafeStorage {
  storage: SimpleStorage;
  /** false = saves only last until the page is closed or reloaded */
  persistent: boolean;
}

/** Pass `() => window.localStorage` (a function, so an error from merely reading it is caught too). */
export function safeStorage(getReal: () => SimpleStorage): SafeStorage {
  try {
    const real = getReal();
    const probe = '__dividend-drive-probe__';
    real.setItem(probe, '1');
    real.removeItem(probe);
    return {
      persistent: true,
      storage: {
        getItem: (key) => {
          try {
            return real.getItem(key);
          } catch {
            return null;
          }
        },
        setItem: (key, value) => {
          try {
            real.setItem(key, value);
          } catch {
            // Storage full or blocked mid-game: skip this save rather than crash.
          }
        },
        removeItem: (key) => {
          try {
            real.removeItem(key);
          } catch {
            // ignore
          }
        },
      },
    };
  } catch {
    const memory = new Map<string, string>();
    return {
      persistent: false,
      storage: {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => {
          memory.set(key, value);
        },
        removeItem: (key) => {
          memory.delete(key);
        },
      },
    };
  }
}
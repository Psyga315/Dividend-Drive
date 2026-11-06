// The game must keep working when the browser blocks storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { safeStorage, type SimpleStorage } from '../src/ui/storage.ts';

function fakeStorage(): SimpleStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test('uses real storage when the browser allows it', () => {
  const real = fakeStorage();
  const { storage, persistent } = safeStorage(() => real);
  assert.equal(persistent, true);
  storage.setItem('k', 'v');
  assert.equal(real.data.get('k'), 'v');
  assert.equal(storage.getItem('k'), 'v');
  assert.equal(real.data.has('__dividend-drive-probe__'), false); // probe cleaned up
});

test('falls back to memory when even reading localStorage throws', () => {
  const { storage, persistent } = safeStorage(() => {
    throw new Error("SecurityError: Failed to read the 'localStorage' property from 'Window'");
  });
  assert.equal(persistent, false);
  assert.equal(storage.getItem('save'), null);
  storage.setItem('save', '{}');
  assert.equal(storage.getItem('save'), '{}');
  storage.removeItem('save');
  assert.equal(storage.getItem('save'), null);
});

test('a full or newly blocked storage never throws', () => {
  let blocked = false;
  const real = fakeStorage();
  const flaky: SimpleStorage = {
    getItem: (k) => {
      if (blocked) throw new Error('blocked');
      return real.getItem(k);
    },
    setItem: (k, v) => {
      if (blocked) throw new Error('QuotaExceededError');
      real.setItem(k, v);
    },
    removeItem: (k) => {
      if (blocked) throw new Error('blocked');
      real.removeItem(k);
    },
  };
  const { storage, persistent } = safeStorage(() => flaky);
  assert.equal(persistent, true);
  blocked = true;
  assert.doesNotThrow(() => storage.setItem('save', 'x'));
  assert.equal(storage.getItem('save'), null);
  assert.doesNotThrow(() => storage.removeItem('save'));
});
import { describe, expect, it } from 'vitest';
import { readAutoCompile, writeAutoCompile } from './preference';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
} as unknown as Storage;

describe('auto-compile preference', () => {
  it('uses the project default until the user chooses', () => {
    const storage = memoryStorage();
    expect(readAutoCompile('o/paper', true, storage)).toBe(true);
    expect(readAutoCompile('o/paper', false, storage)).toBe(false);
  });

  it('remembers the choice per repository', () => {
    const storage = memoryStorage();
    writeAutoCompile('o/paper', true, storage);
    expect(readAutoCompile('o/paper', false, storage)).toBe(true);
    expect(readAutoCompile('o/other', false, storage)).toBe(false);
    writeAutoCompile('o/paper', false, storage);
    expect(readAutoCompile('o/paper', true, storage)).toBe(false);
  });

  it('ignores storage that fails or holds something else', () => {
    expect(readAutoCompile('o/paper', true, throwing)).toBe(true);
    expect(() => writeAutoCompile('o/paper', true, throwing)).not.toThrow();
    expect(readAutoCompile('o/paper', true, undefined)).toBe(true);
    const storage = memoryStorage();
    storage.setItem('galley:auto-compile:o/paper', 'maybe');
    expect(readAutoCompile('o/paper', false, storage)).toBe(false);
  });
});

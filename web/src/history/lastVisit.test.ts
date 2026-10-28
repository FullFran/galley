import { describe, expect, it } from 'vitest';
import { lastVisitBanner, readLastSeen, writeLastSeen, LAST_SEEN_KEY } from './lastVisit';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
};

describe('what changed since the last visit', () => {
  it('remembers the head per user and repository', () => {
    const store = memory();
    writeLastSeen(store, 'ana', 'octo/paper', 'aaaaaaa1');
    writeLastSeen(store, 'ana', 'octo/other', 'bbbbbbb2');
    writeLastSeen(store, 'ben', 'octo/paper', 'ccccccc3');
    expect(readLastSeen(store, 'ana', 'octo/paper')).toBe('aaaaaaa1');
    expect(readLastSeen(store, 'ana', 'Octo/Paper')).toBe('aaaaaaa1');
    expect(readLastSeen(store, 'ben', 'octo/paper')).toBe('ccccccc3');
    expect(readLastSeen(store, 'cid', 'octo/paper')).toBeUndefined();
    expect(store.data.size).toBe(1);
    expect([...store.data.keys()]).toEqual([LAST_SEEN_KEY]);
  });

  it('ignores stored values that are not SHAs or not JSON', () => {
    const store = memory();
    store.setItem(LAST_SEEN_KEY, JSON.stringify({ 'ana@octo/paper': 'javascript:1' }));
    expect(readLastSeen(store, 'ana', 'octo/paper')).toBeUndefined();
    store.setItem(LAST_SEEN_KEY, '{nope');
    expect(readLastSeen(store, 'ana', 'octo/paper')).toBeUndefined();
    writeLastSeen(store, 'ana', 'octo/paper', 'not a sha');
    expect(readLastSeen(store, 'ana', 'octo/paper')).toBeUndefined();
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readLastSeen(broken, 'ana', 'octo/paper')).toBeUndefined();
    expect(() => writeLastSeen(broken, 'ana', 'octo/paper', 'aaaaaaa')).not.toThrow();
    expect(readLastSeen(undefined, 'ana', 'octo/paper')).toBeUndefined();
  });

  it('offers a banner only when the head moved since a remembered visit', () => {
    expect(lastVisitBanner(undefined, 'h2', 3)).toBeUndefined();
    expect(lastVisitBanner('h1', 'h1', 0)).toBeUndefined();
    expect(lastVisitBanner('h1', 'h2', 0)).toBeUndefined();
    expect(lastVisitBanner('h1', 'h2', 3)).toEqual({ since: 'h1', head: 'h2', count: 3 });
  });

  it('keeps at most 200 remembered repositories, dropping the oldest', () => {
    const store = memory();
    for (let i = 0; i < 205; i++) writeLastSeen(store, 'ana', `octo/r${i}`, 'abcdef0');
    const map = JSON.parse(store.getItem(LAST_SEEN_KEY) ?? '{}') as Record<string, string>;
    expect(Object.keys(map)).toHaveLength(200);
    expect(readLastSeen(store, 'ana', 'octo/r0')).toBeUndefined();
    expect(readLastSeen(store, 'ana', 'octo/r204')).toBe('abcdef0');
  });
});

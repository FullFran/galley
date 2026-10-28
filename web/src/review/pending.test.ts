import { describe, expect, it } from 'vitest';
import { splitByHead } from './pending';

describe('splitByHead', () => {
  const a = { path: 'p.qmd', line: 3, side: 'RIGHT' as const, body: 'a', headSha: 'h1' };
  const b = { ...a, body: 'b', headSha: 'h2' };

  it('keeps only comments written against the current head', () => {
    expect(splitByHead([a, b], 'h2')).toEqual({ current: [b], stale: [a] });
  });

  it('after a suggestion is applied (head h1 -> c2), nothing queued on h1 is sent', () => {
    const { current, stale } = splitByHead([a], 'c2');
    expect(current).toEqual([]);
    expect(stale.map((c) => c.body)).toEqual(['a']);
  });
});

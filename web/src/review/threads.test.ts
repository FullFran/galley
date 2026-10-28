import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '../domain';
import { parsePatch } from './diff';
import { anchorKey, groupThreads, placeThreads } from './threads';

const comment = (id: number, extra: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  body: `c${id}`,
  path: 'paper.qmd',
  line: 4,
  startLine: null,
  side: 'RIGHT',
  diffHunk: '@@ -1 +1 @@',
  subjectType: 'line',
  createdAt: `2026-10-0${id}T00:00:00Z`,
  ...extra,
});

describe('groupThreads', () => {
  it('groups replies under their first comment, in time order', () => {
    const threads = groupThreads([
      comment(3, { inReplyToId: 1 }),
      comment(1),
      comment(2, { path: 'b.qmd', line: null }),
      comment(4, { inReplyToId: 1 }),
    ]);

    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual([
      [1, [3, 4]],
      [2, []],
    ]);
    expect(threads[0]?.key).toBe(anchorKey('paper.qmd', 'RIGHT', 4));
    expect(threads[1]?.key).toBeUndefined();
  });

  it('marks file-level comments as such, not as outdated', () => {
    const [thread] = groupThreads([comment(6, { line: null, subjectType: 'file' })]);
    expect(thread?.key).toBeUndefined();
    expect(thread?.root.subjectType).toBe('file');
  });

  it('keeps a reply whose first comment is missing as its own thread', () => {
    expect(groupThreads([comment(5, { inReplyToId: 99 })]).map((t) => t.root.id)).toEqual([5]);
  });
});

describe('placeThreads', () => {
  const lines = parsePatch('@@ -3,2 +5,2 @@\n x\n-y\n+z');

  it('places LEFT threads on unchanged lines and keeps unplaceable ones', () => {
    const threads = groupThreads([
      comment(1, { side: 'LEFT', line: 3 }),
      comment(2, { side: 'RIGHT', line: 5 }),
      comment(3, { side: 'RIGHT', line: 40 }),
      comment(4, { line: null }),
      comment(5, { line: null, subjectType: 'file' }),
    ]);

    const placed = placeThreads(lines, 'paper.qmd', threads);

    expect([...placed.byLine.entries()].map(([i, ts]) => [i, ts.map((t) => t.root.id)])).toEqual([[1, [1, 2]]]);
    expect(placed.earlier.map((t) => t.root.id)).toEqual([3, 4]);
    expect(placed.file.map((t) => t.root.id)).toEqual([5]);
  });
});

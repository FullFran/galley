import { describe, expect, it } from 'vitest';
import { aggregateActivity, weekStart } from './activity';

describe('team activity', () => {
  const since = new Date('2026-10-21T10:00:00Z');
  it('counts per person in the last 7 days, in alphabetical order (no ranking)', () => {
    const rows = aggregateActivity(
      {
        commits: [
          { sha: 'a', login: 'ben', date: '2026-10-22T00:00:00Z' },
          { sha: 'a', login: 'ben', date: '2026-10-22T00:00:00Z' },
          { sha: 'b', login: 'Ana', date: '2026-10-23T00:00:00Z' },
          { sha: 'c', login: 'ana', date: '2026-10-01T00:00:00Z' },
        ],
        pulls: [
          { number: 1, login: 'ana', createdAt: '2026-10-22T00:00:00Z', mergedAt: '2026-10-24T00:00:00Z' },
          { number: 2, login: 'cleo', createdAt: '2026-09-22T00:00:00Z', mergedAt: '2026-10-25T00:00:00Z' },
          { number: 3, login: 'cleo', createdAt: '2026-09-22T00:00:00Z' },
        ],
        reviews: [
          { login: 'ben', submittedAt: '2026-10-24T00:00:00Z' },
          { login: 'ben', submittedAt: '2026-10-02T00:00:00Z' },
        ],
        comments: [
          { id: 1, login: 'cleo', createdAt: '2026-10-26T00:00:00Z' },
          { id: 2, login: 'dependabot[bot]', createdAt: '2026-10-26T00:00:00Z' },
        ],
      },
      since,
    );
    expect(rows).toEqual([
      { login: 'ana', commits: 1, opened: 1, merged: 1, reviews: 0, comments: 0 },
      { login: 'ben', commits: 1, opened: 0, merged: 0, reviews: 1, comments: 0 },
      { login: 'cleo', commits: 0, opened: 0, merged: 1, reviews: 0, comments: 1 },
    ]);
  });

  it('starts the window 7 days ago', () => {
    expect(weekStart(new Date('2026-10-28T10:00:00Z')).toISOString()).toBe('2026-10-21T10:00:00.000Z');
  });
});

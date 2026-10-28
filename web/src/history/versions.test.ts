import { describe, expect, it } from 'vitest';
import { proposalOf, shortSha, tagNameProblem, toVersion, withLabels, type GhCommit } from './versions';

const commit = (message: string, extra: Partial<GhCommit> = {}): GhCommit => ({
  sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  commit: { message, author: { name: 'Ana Pérez', date: '2026-10-27T10:00:00Z' }, committer: { date: '2026-10-27T11:00:00Z' } },
  author: { login: 'ana' },
  parents: [{ sha: 'p1' }],
  html_url: 'https://github.com/octo/paper/commit/a1b2c3d',
  ...extra,
});

describe('versions of the default branch', () => {
  it('shows the first line of the message, the author login and the commit date', () => {
    expect(toVersion(commit('Fix the abstract\n\nLonger explanation.'))).toEqual({
      sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      title: 'Fix the abstract',
      author: 'ana',
      date: '2026-10-27T11:00:00Z',
      merge: false,
      labels: [],
      htmlUrl: 'https://github.com/octo/paper/commit/a1b2c3d',
    });
  });

  it('falls back to the git author name when the commit has no GitHub account', () => {
    expect(toVersion(commit('x', { author: null })).author).toBe('Ana Pérez');
  });

  it('shows a merged proposal as its number and title', () => {
    const v = toVersion(commit('Merge pull request #12 from octo/galley/ana\n\nRewrite the introduction', { parents: [{ sha: 'p1' }, { sha: 'p2' }] }));
    expect(v.proposal).toEqual({ number: 12, title: 'Rewrite the introduction' });
    expect(v.merge).toBe(true);
  });

  it('recognises squash merges ("Title (#N)") as proposals too', () => {
    expect(proposalOf('Rewrite the introduction (#7)\n\n* commits')).toEqual({ number: 7, title: 'Rewrite the introduction' });
  });

  it('leaves ordinary commits alone', () => {
    expect(proposalOf('Merge branch main into galley/ana')).toBeUndefined();
    expect(proposalOf('Mention issue #4 in the text')).toBeUndefined();
  });

  it('uses the branch name when a merged proposal has no title line', () => {
    expect(proposalOf('Merge pull request #3 from octo/galley/ana')).toEqual({ number: 3, title: '' });
  });

  it('puts labels (tags) on the version they point at', () => {
    const versions = [toVersion(commit('a', { sha: 's1' })), toVersion(commit('b', { sha: 's2' }))];
    const labelled = withLabels(versions, [
      { name: 'submitted', sha: 's2' },
      { name: 'v1', sha: 's2' },
      { name: 'elsewhere', sha: 's9' },
    ]);
    expect(labelled.map((v) => v.labels)).toEqual([[], ['submitted', 'v1']]);
  });

  it('shortens SHAs to seven characters', () => {
    expect(shortSha('a1b2c3d4e5f6')).toBe('a1b2c3d');
  });
});

describe('label names', () => {
  it.each(['submitted', 'v1.0', 'review-2', 'journal/round-1', 'Ana_draft'])('accepts %s', (name) => {
    expect(tagNameProblem(name, [])).toBeUndefined();
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['two words', 'invalid'],
    ['a..b', 'invalid'],
    ['-x', 'invalid'],
    ['/x', 'invalid'],
    ['x/', 'invalid'],
    ['x.', 'invalid'],
    ['x.lock', 'invalid'],
    ['a//b', 'invalid'],
    ['a/.b', 'invalid'],
    ['a@{b', 'invalid'],
    ['@', 'invalid'],
    ['a~1', 'invalid'],
    ['a^', 'invalid'],
    ['a:b', 'invalid'],
    ['a?', 'invalid'],
    ['a*', 'invalid'],
    ['a[b', 'invalid'],
    ['a\\b', 'invalid'],
    ['a\tb', 'invalid'],
    ['x'.repeat(101), 'tooLong'],
  ])('refuses %j (%s)', (name, problem) => {
    expect(tagNameProblem(name, [])).toBe(problem);
  });

  it('refuses a name that is already a label', () => {
    expect(tagNameProblem('submitted', ['submitted'])).toBe('taken');
  });
});

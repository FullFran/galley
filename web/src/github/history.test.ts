import { describe, expect, it, vi } from 'vitest';
import { RejectedError, type Repository } from '../domain';
import { fakeFetch, json, on, type Route } from '../test/fakeFetch';
import { createGitHubHistoryGateway, zipUrl } from './history';

const GH = 'https://api.github.com';
const R = `${GH}/repos/octo/paper`;
const repo: Repository = { id: 7, owner: 'octo', name: 'paper', fullName: 'octo/paper', defaultBranch: 'main', private: true };

function gateway(routes: Route[]) {
  const tokens = { getAccessToken: vi.fn(async () => 'tok'), invalidate: vi.fn() };
  const fake = fakeFetch(routes);
  return { gw: createGitHubHistoryGateway({ tokens, fetch: fake.fetch }), ...fake, tokens };
}

const ghCommit = (sha: string, message: string, parents = 1) => ({
  sha,
  commit: { message, author: { name: 'Ana', date: '2026-10-27T10:00:00Z' }, committer: { date: '2026-10-27T10:00:00Z' } },
  author: { login: 'ana' },
  parents: Array.from({ length: parents }, (_, i) => ({ sha: `p${i}` })),
  html_url: `https://github.com/octo/paper/commit/${sha}`,
});

describe('GitHub history gateway', () => {
  it('lists versions of the default branch a page at a time', async () => {
    const { gw, tokens } = gateway([
      on('GET', `${R}/commits?sha=main&per_page=30&page=1`, () =>
        json([ghCommit('s2', 'Merge pull request #4 from octo/galley/ana\n\nNew results', 2), ghCommit('s1', 'Start')], 200, {
          Link: `<${R}/commits?sha=main&per_page=30&page=2>; rel="next"`,
        }),
      ),
      on('GET', `${R}/commits?sha=main&per_page=30&page=2`, () => json([ghCommit('s0', 'Initial commit')])),
    ]);
    const first = await gw.versions(repo, 1);
    expect(first.more).toBe(true);
    expect(first.versions.map((v) => [v.sha, v.title, v.proposal?.number])).toEqual([
      ['s2', 'Merge pull request #4 from octo/galley/ana', 4],
      ['s1', 'Start', undefined],
    ]);
    const second = await gw.versions(repo, 2);
    expect(second.more).toBe(false);
    expect(tokens.getAccessToken).toHaveBeenCalledWith(7);
  });

  it('lists labels (tags) with the commit each points at', async () => {
    const { gw } = gateway([
      on('GET', `${R}/tags?per_page=100`, () =>
        json([
          { name: 'submitted', commit: { sha: 's2' } },
          { name: 'v1', commit: { sha: 's1' } },
        ]),
      ),
    ]);
    expect(await gw.labels(repo)).toEqual([
      { name: 'submitted', sha: 's2' },
      { name: 'v1', sha: 's1' },
    ]);
  });

  it('compares two versions and maps the changed files for the diff view', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/compare/aaaaaaa...bbbbbbb?per_page=100`, () =>
        json({
          total_commits: 3,
          files: [
            { filename: 'a.qmd', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-x\n+y\n+z' },
            { filename: 'b.qmd', previous_filename: 'old.qmd', status: 'renamed', additions: 0, deletions: 0 },
            { filename: 'fig.png', status: 'added', additions: 0, deletions: 0 },
          ],
        }),
      ),
    ]);
    const result = await gw.compare(repo, 'aaaaaaa', 'bbbbbbb');
    expect(requests).toHaveLength(1);
    expect(result).toEqual({
      base: 'aaaaaaa',
      head: 'bbbbbbb',
      commits: 3,
      truncated: false,
      files: [
        { path: 'a.qmd', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-x\n+y\n+z' },
        { path: 'b.qmd', previousPath: 'old.qmd', status: 'renamed', additions: 0, deletions: 0 },
        { path: 'fig.png', status: 'added', additions: 0, deletions: 0 },
      ],
    });
  });

  it('says when GitHub cut the list of changed files', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.qmd`, status: 'modified', additions: 1, deletions: 0 }));
    const { gw } = gateway([on('GET', `${R}/compare/aaaaaaa...bbbbbbb?per_page=100`, () => json({ total_commits: 1, files }))]);
    expect((await gw.compare(repo, 'aaaaaaa', 'bbbbbbb')).truncated).toBe(true);
  });

  it('reads the blob of every file of a version', async () => {
    const { gw } = gateway([
      on('GET', `${R}/git/trees/s1?recursive=1`, () =>
        json({
          truncated: false,
          tree: [
            { path: 'a.qmd', type: 'blob', mode: '100644', sha: 'b1' },
            { path: 'sections', type: 'tree', mode: '040000', sha: 't1' },
          ],
        }),
      ),
    ]);
    expect(await gw.tree(repo, 's1')).toEqual({ blobs: { 'a.qmd': 'b1' }, truncated: false });
  });

  it('adds a label as a lightweight tag ref and removes it again', async () => {
    const { gw, requests } = gateway([
      on('POST', `${R}/git/refs`, () => json({ ref: 'refs/tags/journal/round-1' }, 201)),
      on('DELETE', `${R}/git/refs/tags/journal/round-1`, () => new Response(null, { status: 204 })),
    ]);
    await gw.addLabel(repo, 'journal/round-1', 's1');
    await gw.removeLabel(repo, 'journal/round-1');
    expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ['POST', `${R}/git/refs`, { ref: 'refs/tags/journal/round-1', sha: 's1' }],
      ['DELETE', `${R}/git/refs/tags/journal/round-1`, undefined],
    ]);
  });

  it('refuses invalid label names before sending anything', async () => {
    const { gw, requests } = gateway([]);
    await expect(gw.addLabel(repo, 'two words', 's1')).rejects.toThrow(RejectedError);
    await expect(gw.removeLabel(repo, '../heads/main')).rejects.toThrow(RejectedError);
    expect(requests).toHaveLength(0);
  });

  it('reports a label that already exists as RejectedError', async () => {
    const { gw } = gateway([on('POST', `${R}/git/refs`, () => json({ message: 'Reference already exists' }, 422))]);
    await expect(gw.addLabel(repo, 'v1', 's1')).rejects.toThrow(RejectedError);
  });

  it('links the zip of a version on github.com (codeload does not allow galley to fetch it)', () => {
    expect(zipUrl(repo, 'a1b2c3d')).toBe('https://github.com/octo/paper/archive/a1b2c3d.zip');
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  AuthRequiredError,
  ConflictError,
  NotFoundError,
  NotTextError,
  PermissionError,
  TransientError,
  type Repository,
} from '../domain';
import { fakeFetch, json, on, type RecordedRequest, type Route } from '../test/fakeFetch';
import { createGitHubGateway } from './gateway';

const GH = 'https://api.github.com';
const R = `${GH}/repos/octo/paper`;
const repo: Repository = {
  id: 7,
  owner: 'octo',
  name: 'paper',
  fullName: 'octo/paper',
  defaultBranch: 'main',
  private: true,
};

function tokens() {
  return { getAccessToken: vi.fn(async () => 'tok'), invalidate: vi.fn() };
}

function gateway(routes: Route[], source = tokens()) {
  const fake = fakeFetch([on('GET', `${GH}/user`, () => json({ login: 'ana' })), ...routes]);
  return { gw: createGitHubGateway({ tokens: source, fetch: fake.fetch }), ...fake, source };
}

const calls = (requests: RecordedRequest[]) => requests.map((r) => `${r.method} ${r.url}`);

describe('GitHub gateway', () => {
  it('lists repositories of every installation, following Link pagination', async () => {
    const page2 = `${GH}/user/installations/1/repositories?per_page=100&page=2`;
    const { gw, requests } = gateway([
      on('GET', `${GH}/user/installations?per_page=100`, () =>
        json({ installations: [{ id: 1 }, { id: 2 }] }),
      ),
      on('GET', `${GH}/user/installations/1/repositories?per_page=100`, () =>
        json(
          { repositories: [ghRepo(10, 'octo', 'a')] },
          200,
          { Link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
        ),
      ),
      on('GET', page2, () => json({ repositories: [ghRepo(11, 'octo', 'b')] })),
      on('GET', `${GH}/user/installations/2/repositories?per_page=100`, () =>
        json({ repositories: [ghRepo(12, 'team', 'c')] }),
      ),
    ]);

    const repos = await gw.listRepositories();

    expect(repos.map((r) => r.fullName)).toEqual(['octo/a', 'octo/b', 'team/c']);
    expect(repos[0]).toEqual({
      id: 10,
      owner: 'octo',
      name: 'a',
      fullName: 'octo/a',
      defaultBranch: 'main',
      private: false,
    });
    const first = requests[0] as RecordedRequest;
    expect(first.headers.get('Authorization')).toBe('Bearer tok');
    expect(first.headers.get('Accept')).toBe('application/vnd.github+json');
    expect(first.headers.get('X-GitHub-Api-Version')).toBe('2022-11-28');
  });

  it('refuses to follow pagination links to another host', async () => {
    const { gw, requests } = gateway([
      on('GET', `${GH}/user/installations?per_page=100`, () =>
        json({ installations: [] }, 200, { Link: '<https://evil.test/steal>; rel="next"' }),
      ),
    ]);

    await expect(gw.listRepositories()).rejects.toThrow(/unexpected host/);
    expect(requests.some((r) => r.url.startsWith('https://evil.test'))).toBe(false);
  });

  it('opens the existing working branch', async () => {
    const { gw, requests, source } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'b1' } })),
      on('GET', `${R}/compare/main...galley/ana`, () =>
        json({ ahead_by: 0, behind_by: 0, base_commit: { sha: 'b1' } }),
      ),
      on('GET', `${R}/git/trees/b1?recursive=1`, () =>
        json({
          truncated: false,
          tree: [
            { path: 'docs', type: 'tree' },
            { path: 'docs/paper.qmd', type: 'blob' },
            { path: 'README.md', type: 'blob' },
            { path: 'vendor/lib', type: 'commit' },
          ],
        }),
      ),
    ]);

    await expect(gw.openRepository(repo)).resolves.toEqual({
      branch: 'galley/ana',
      branchExists: true,
      headSha: 'b1',
      files: ['docs/paper.qmd', 'README.md'],
      truncated: false,
    });
    expect(calls(requests)).not.toContain(`GET ${R}/git/ref/heads/main`);
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
    expect(source.getAccessToken).toHaveBeenCalledWith(7);
  });

  it('fast-forwards a working branch that is only behind the default branch', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'old' } })),
      on('GET', `${R}/compare/main...galley/ana`, () =>
        json({ ahead_by: 0, behind_by: 3, base_commit: { sha: 'm9' } }),
      ),
      on('PATCH', `${R}/git/refs/heads/galley/ana`, () => json({ object: { sha: 'm9' } })),
      on('GET', `${R}/git/trees/m9?recursive=1`, () => json({ truncated: false, tree: [] })),
    ]);

    const state = await gw.openRepository(repo);

    expect(state).toMatchObject({ branchExists: true, headSha: 'm9' });
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ sha: 'm9', force: false });
  });

  it('keeps a working branch that is only ahead of the default branch', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'b1' } })),
      on('GET', `${R}/compare/main...galley/ana`, () =>
        json({ ahead_by: 2, behind_by: 0, base_commit: { sha: 'm9' } }),
      ),
      on('GET', `${R}/git/trees/b1?recursive=1`, () => json({ truncated: false, tree: [] })),
    ]);

    await expect(gw.openRepository(repo)).resolves.toMatchObject({ headSha: 'b1' });
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
  });

  it('opens the default branch head when the working branch does not exist', async () => {
    const { gw } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ message: 'Not Found' }, 404)),
      on('GET', `${R}/git/ref/heads/main`, () => json({ object: { sha: 'm1' } })),
      on('GET', `${R}/git/trees/m1?recursive=1`, () =>
        json({ truncated: true, tree: [{ path: 'a.md', type: 'blob' }] }),
      ),
    ]);

    await expect(gw.openRepository(repo)).resolves.toEqual({
      branch: 'galley/ana',
      branchExists: false,
      headSha: 'm1',
      files: ['a.md'],
      truncated: true,
    });
  });

  it('reads a file and decodes base64 as UTF-8', async () => {
    const { gw } = gateway([
      on('GET', `${R}/contents/docs/se%C3%B1al%20v1.md?ref=b1`, () =>
        json({ type: 'file', encoding: 'base64', content: 'IyBTZcOxYWwgwrUKxYLDs2TF\nuiDigJQg5pel5pysCg==\n' }),
      ),
    ]);

    await expect(gw.readFile(repo, 'docs/señal v1.md', 'b1')).resolves.toBe('# Señal µ\nłódź — 日本\n');
  });

  it('saves a new branch as one commit, then opens a pull request', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ message: 'Not Found' }, 404)),
      on('GET', `${R}/git/commits/m1`, () => json({ sha: 'm1', tree: { sha: 'tree-m1' } })),
      on('GET', `${R}/git/trees/tree-m1?recursive=1`, () =>
        json({ truncated: false, tree: [{ path: 'docs/paper.qmd', type: 'blob', mode: '100755' }] }),
      ),
      on('POST', `${R}/git/trees`, () => json({ sha: 'tree-new' }, 201)),
      on('POST', `${R}/git/commits`, () => json({ sha: 'c2' }, 201)),
      on('POST', `${R}/git/refs`, () => json({ object: { sha: 'c2' } }, 201)),
      on('GET', `${R}/pulls?state=open&head=octo%3Agalley%2Fana&per_page=1`, () => json([])),
      on('POST', `${R}/pulls`, () => json({ html_url: 'https://github.com/octo/paper/pull/3' }, 201)),
    ]);

    const result = await gw.save(
      repo,
      [
        { path: 'docs/paper.qmd', content: 'Señal µ' },
        { path: 'b.md', content: 'b' },
      ],
      'Edit paper\n\nDetails',
      'm1',
    );

    expect(result).toEqual({ commitSha: 'c2', pullRequestUrl: 'https://github.com/octo/paper/pull/3' });
    expect(calls(requests)).toEqual([
      `GET ${GH}/user`,
      `GET ${R}/git/ref/heads/galley/ana`,
      `GET ${R}/git/commits/m1`,
      `GET ${R}/git/trees/tree-m1?recursive=1`,
      `POST ${R}/git/trees`,
      `POST ${R}/git/commits`,
      `POST ${R}/git/refs`,
      `GET ${R}/pulls?state=open&head=octo%3Agalley%2Fana&per_page=1`,
      `POST ${R}/pulls`,
    ]);
    expect(requests[4]?.body).toEqual({
      base_tree: 'tree-m1',
      tree: [
        { path: 'docs/paper.qmd', mode: '100755', type: 'blob', content: 'Señal µ' },
        { path: 'b.md', mode: '100644', type: 'blob', content: 'b' },
      ],
    });
    expect(requests[5]?.body).toEqual({ message: 'Edit paper\n\nDetails', tree: 'tree-new', parents: ['m1'] });
    expect(requests[6]?.body).toEqual({ ref: 'refs/heads/galley/ana', sha: 'c2' });
    expect(requests[8]?.body).toMatchObject({ title: 'Edit paper', head: 'galley/ana', base: 'main' });
  });

  it('fast-forwards an existing branch with force false and reuses its open pull request', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'b1' } })),
      on('GET', `${R}/git/commits/b1`, () => json({ sha: 'b1', tree: { sha: 'tree-b1' } })),
      on('GET', `${R}/git/trees/tree-b1?recursive=1`, () =>
        json({ truncated: false, tree: [{ path: 'docs/paper.qmd', type: 'blob', mode: '100755' }] }),
      ),
      on('POST', `${R}/git/trees`, () => json({ sha: 'tree-new' }, 201)),
      on('POST', `${R}/git/commits`, () => json({ sha: 'c2' }, 201)),
      on('PATCH', `${R}/git/refs/heads/galley/ana`, () => json({ object: { sha: 'c2' } })),
      on('GET', `${R}/pulls?state=open&head=octo%3Agalley%2Fana&per_page=1`, () =>
        json([{ html_url: 'https://github.com/octo/paper/pull/2' }]),
      ),
    ]);

    const result = await gw.save(repo, [{ path: 'a.md', content: 'x' }], 'Edit', 'b1');

    expect(result.pullRequestUrl).toBe('https://github.com/octo/paper/pull/2');
    const patch = requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({ sha: 'c2', force: false });
    expect(requests.find((r) => r.url === `${R}/git/commits`)?.body).toMatchObject({ parents: ['b1'] });
    expect(calls(requests)).not.toContain(`POST ${R}/pulls`);
  });

  it('reports a non-fast-forward ref update as ConflictError and opens no pull request', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'b1' } })),
      on('GET', `${R}/git/commits/b1`, () => json({ sha: 'b1', tree: { sha: 'tree-b1' } })),
      on('GET', `${R}/git/trees/tree-b1?recursive=1`, () =>
        json({ truncated: false, tree: [{ path: 'docs/paper.qmd', type: 'blob', mode: '100755' }] }),
      ),
      on('POST', `${R}/git/trees`, () => json({ sha: 'tree-new' }, 201)),
      on('POST', `${R}/git/commits`, () => json({ sha: 'c2' }, 201)),
      on('PATCH', `${R}/git/refs/heads/galley/ana`, () =>
        json({ message: 'Update is not a fast forward' }, 422),
      ),
    ]);

    await expect(gw.save(repo, [{ path: 'a.md', content: 'x' }], 'Edit', 'b1')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(requests.some((r) => r.url.includes('/pulls'))).toBe(false);
  });

  it('reports a moved branch as ConflictError before creating any object', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'b2' } })),
    ]);

    await expect(gw.save(repo, [{ path: 'a.md', content: 'x' }], 'Edit', 'b1')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('reports a branch created concurrently as ConflictError', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ message: 'Not Found' }, 404)),
      on('GET', `${R}/git/commits/m1`, () => json({ sha: 'm1', tree: { sha: 'tree-m1' } })),
      on('GET', `${R}/git/trees/tree-m1?recursive=1`, () =>
        json({ truncated: false, tree: [{ path: 'docs/paper.qmd', type: 'blob', mode: '100755' }] }),
      ),
      on('POST', `${R}/git/trees`, () => json({ sha: 'tree-new' }, 201)),
      on('POST', `${R}/git/commits`, () => json({ sha: 'c2' }, 201)),
      on('POST', `${R}/git/refs`, () => json({ message: 'Reference already exists' }, 422)),
    ]);

    await expect(gw.save(repo, [{ path: 'a.md', content: 'x' }], 'Edit', 'm1')).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(requests.some((r) => r.url.includes('/pulls'))).toBe(false);
  });

  it('refreshes the token once on 401, then reports AuthRequiredError', async () => {
    const statuses = [401, 200, 401, 401];
    const source = tokens();
    const { gw, requests } = gateway(
      [
        on('GET', `${GH}/user/installations?per_page=100`, () =>
          json({ installations: [] }, statuses.shift() ?? 500),
        ),
      ],
      source,
    );

    await expect(gw.listRepositories()).resolves.toEqual([]);
    expect(source.invalidate).toHaveBeenCalledTimes(1);
    await expect(gw.listRepositories()).rejects.toBeInstanceOf(AuthRequiredError);
    expect(source.invalidate).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(4);
  });

  it('maps HTTP failures to typed errors', async () => {
    const answers: (() => Response)[] = [
      () => json({ message: 'Not Found' }, 404),
      () => json({ message: 'Resource not accessible by integration' }, 403),
      () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }),
      () => json({ message: 'Too many requests' }, 429),
      () => json({ message: 'Bad gateway' }, 502),
      () => {
        throw new TypeError('Failed to fetch');
      },
    ];
    const { gw } = gateway([
      on('GET', `${R}/contents/a.md?ref=main`, () => (answers.shift() as () => Response)()),
    ]);
    const read = () => gw.readFile(repo, 'a.md', 'main');

    await expect(read()).rejects.toBeInstanceOf(NotFoundError);
    await expect(read()).rejects.toBeInstanceOf(PermissionError);
    await expect(read()).rejects.toBeInstanceOf(TransientError);
    await expect(read()).rejects.toBeInstanceOf(TransientError);
    await expect(read()).rejects.toBeInstanceOf(TransientError);
    await expect(read()).rejects.toBeInstanceOf(TransientError);
  });

  it('reports a malformed GitHub response as TransientError', async () => {
    const { gw } = gateway([on('GET', `${R}/contents/a.md?ref=main`, () => new Response('<html>'))]);

    await expect(gw.readFile(repo, 'a.md', 'main')).rejects.toBeInstanceOf(TransientError);
  });

  it('rejects a file that is not valid UTF-8', async () => {
    const { gw } = gateway([
      // "Se\xf1al" in Latin-1.
      on('GET', `${R}/contents/a.md?ref=main`, () => json({ type: 'file', encoding: 'base64', content: 'U2XxYWw=' })),
    ]);

    await expect(gw.readFile(repo, 'a.md', 'main')).rejects.toBeInstanceOf(NotTextError);
  });

  it('keeps a byte order mark through read and save', async () => {
    const { gw, requests } = gateway([
      // EF BB BF "hi"
      on('GET', `${R}/contents/a.md?ref=b1`, () => json({ type: 'file', encoding: 'base64', content: '77u/aGk=' })),
      ...savedOnExistingBranch(),
      on('GET', `${R}/pulls?state=open&head=octo%3Agalley%2Fana&per_page=1`, () => json([{ html_url: 'u' }])),
    ]);

    const text = await gw.readFile(repo, 'a.md', 'b1');
    expect(text).toBe('\uFEFFhi');
    await gw.save(repo, [{ path: 'a.md', content: text }], 'Edit', 'b1');
    const tree = requests.find((r) => r.method === 'POST' && r.url === `${R}/git/trees`);
    expect(tree?.body).toMatchObject({ tree: [{ content: '\uFEFFhi' }] });
  });

  it('returns the commit even when the pull request step fails', async () => {
    const { gw } = gateway([
      ...savedOnExistingBranch(),
      on('GET', `${R}/pulls?state=open&head=octo%3Agalley%2Fana&per_page=1`, () => json({ message: 'boom' }, 502)),
    ]);

    await expect(gw.save(repo, [{ path: 'a.md', content: 'x' }], 'Edit', 'b1')).resolves.toEqual({
      commitSha: 'c2',
      pullRequestUrl: undefined,
    });
  });

  it('looks the pull request up again when creating it reports it already exists', async () => {
    let lookups = 0;
    const { gw } = gateway([
      ...savedOnExistingBranch(),
      on('GET', `${R}/pulls?state=open&head=octo%3Agalley%2Fana&per_page=1`, () => json(++lookups === 1 ? [] : [{ html_url: 'https://github.com/octo/paper/pull/4' }])),
      on('POST', `${R}/pulls`, () => json({ message: 'A pull request already exists' }, 422)),
    ]);

    const result = await gw.save(repo, [{ path: 'a.md', content: 'x' }], 'Edit', 'b1');
    expect(result.pullRequestUrl).toBe('https://github.com/octo/paper/pull/4');
    expect(lookups).toBe(2);
  });

  it('deletes a diverged working branch whose last pull request was squash-merged at its head', async () => {
    const { gw, requests } = gateway([
      ...diverged(),
      on('GET', `${R}/pulls?state=open&head=octo%3Agalley%2Fana&per_page=1`, () => json([])),
      on('GET', `${R}/pulls?state=closed&head=octo%3Agalley%2Fana&sort=updated&direction=desc&per_page=1`, () =>
        json([{ merged_at: '2026-10-01T00:00:00Z', head: { sha: 'b1' } }]),
      ),
      on('DELETE', `${R}/git/refs/heads/galley/ana`, () => new Response(null, { status: 204 })),
      on('GET', `${R}/git/ref/heads/main`, () => json({ object: { sha: 'm9' } })),
      on('GET', `${R}/git/trees/m9?recursive=1`, () => json({ truncated: false, tree: [] })),
    ]);

    await expect(gw.openRepository(repo)).resolves.toMatchObject({ branchExists: false, headSha: 'm9' });
    expect(calls(requests)).toContain(`DELETE ${R}/git/refs/heads/galley/ana`);
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
  });

  it('keeps a diverged working branch whose last closed pull request was not merged', async () => {
    const { gw, requests } = gateway([
      ...diverged(),
      on('GET', `${R}/pulls?state=open&head=octo%3Agalley%2Fana&per_page=1`, () => json([])),
      on('GET', `${R}/pulls?state=closed&head=octo%3Agalley%2Fana&sort=updated&direction=desc&per_page=1`, () => json([{ merged_at: null, head: { sha: 'b1' } }])),
      on('GET', `${R}/git/trees/b1?recursive=1`, () => json({ truncated: false, tree: [] })),
    ]);

    await expect(gw.openRepository(repo)).resolves.toMatchObject({ branchExists: true, headSha: 'b1' });
    expect(requests.some((r) => r.method === 'DELETE' || r.method === 'PATCH')).toBe(false);
  });

  it('keeps a diverged working branch with an open pull request', async () => {
    const { gw, requests } = gateway([
      ...diverged(),
      on('GET', `${R}/pulls?state=open&head=octo%3Agalley%2Fana&per_page=1`, () => json([{ html_url: 'u' }])),
      on('GET', `${R}/git/trees/b1?recursive=1`, () => json({ truncated: false, tree: [] })),
    ]);

    await expect(gw.openRepository(repo)).resolves.toMatchObject({ branchExists: true, headSha: 'b1' });
    expect(requests.some((r) => r.method === 'DELETE' || r.url.includes('state=closed'))).toBe(false);
  });
});

function diverged(): Route[] {
  return [
    on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'b1' } })),
    on('GET', `${R}/compare/main...galley/ana`, () =>
      json({ ahead_by: 1, behind_by: 2, base_commit: { sha: 'm9' } }),
    ),
  ];
}

/** Routes for a save on an existing branch at b1 that lands commit c2. */
function savedOnExistingBranch(): Route[] {
  return [
    on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'b1' } })),
    on('GET', `${R}/git/commits/b1`, () => json({ sha: 'b1', tree: { sha: 'tree-b1' } })),
    on('GET', `${R}/git/trees/tree-b1?recursive=1`, () => json({ truncated: false, tree: [] })),
    on('POST', `${R}/git/trees`, () => json({ sha: 'tree-new' }, 201)),
    on('POST', `${R}/git/commits`, () => json({ sha: 'c2' }, 201)),
    on('PATCH', `${R}/git/refs/heads/galley/ana`, () => json({ object: { sha: 'c2' } })),
  ];
}

function ghRepo(id: number, owner: string, name: string) {
  return {
    id,
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner },
    default_branch: 'main',
    private: false,
  };
}

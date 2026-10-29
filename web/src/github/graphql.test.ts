import { describe, expect, it, vi } from 'vitest';
import { GatewayError, NotFoundError, PermissionError, TransientError, type Repository } from '../domain';
import { fakeFetch, json, type RecordedRequest, type Route } from '../test/fakeFetch';
import { GITHUB_GRAPHQL, GitHubClient } from './client';
import { createGitHubReviewGateway } from './review';

const repo: Repository = { id: 7, owner: 'octo', name: 'paper', fullName: 'octo/paper', defaultBranch: 'main', private: true };
const tokens = () => ({ getAccessToken: vi.fn(async () => 'tok'), invalidate: vi.fn() });

function setup(routes: Route[]) {
  const source = tokens();
  const fake = fakeFetch(routes);
  return { gw: createGitHubReviewGateway({ tokens: source, fetch: fake.fetch }), client: new GitHubClient(source, fake.fetch), ...fake, source };
}

const graphql = (respond: (req: RecordedRequest) => Response): Route => (req) =>
  req.method === 'POST' && req.url === 'https://api.github.com/graphql' ? respond(req) : undefined;

describe('GitHub GraphQL', () => {
  it('posts the query and variables to api.github.com/graphql with the repository token', async () => {
    const { client, requests, source } = setup([graphql(() => json({ data: { viewer: { login: 'ana' } } }))]);
    const data = await client.graphql<{ viewer: { login: string } }>('query { viewer { login } }', { a: 1 }, 7);
    expect(data.viewer.login).toBe('ana');
    expect(GITHUB_GRAPHQL).toBe('https://api.github.com/graphql');
    const req = requests[0] as RecordedRequest;
    expect(req.body).toEqual({ query: 'query { viewer { login } }', variables: { a: 1 } });
    expect(req.headers.get('Authorization')).toBe('Bearer tok');
    expect(source.getAccessToken).toHaveBeenCalledWith();
  });

  it.each([
    ['NOT_FOUND', NotFoundError],
    ['FORBIDDEN', PermissionError],
    ['RATE_LIMITED', TransientError],
    ['SOMETHING', GatewayError],
  ])('maps a %s error in a 200 response', async (type, error) => {
    const { client } = setup([graphql(() => json({ data: null, errors: [{ type, message: 'no' }] }))]);
    await expect(client.graphql('query { x }', {})).rejects.toBeInstanceOf(error);
  });

  it('lists review threads with their node ids and what the viewer may do', async () => {
    const page = (after: string | null, hasNext: boolean, nodes: unknown[]) =>
      json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: hasNext, endCursor: after ? 'c2' : 'c1' }, nodes } } } } });
    let call = 0;
    const { gw, requests } = setup([
      graphql(() =>
        ++call === 1
          ? page(null, true, [{ id: 'PRRT_1', isResolved: false, viewerCanResolve: true, viewerCanUnresolve: false, comments: { nodes: [{ databaseId: 11 }] } }])
          : page('c1', false, [
              { id: 'PRRT_2', isResolved: true, viewerCanResolve: false, viewerCanUnresolve: true, comments: { nodes: [{ databaseId: 12 }] } },
              { id: 'bad', comments: { nodes: [] } },
            ]),
      ),
    ]);
    const threads = await gw.listReviewThreads(repo, 4);
    expect(threads).toEqual([
      { id: 'PRRT_1', rootCommentId: 11, resolved: false, canResolve: true, canUnresolve: false },
      { id: 'PRRT_2', rootCommentId: 12, resolved: true, canResolve: false, canUnresolve: true },
    ]);
    const first = requests[0] as RecordedRequest;
    expect(first.body).toMatchObject({ variables: { owner: 'octo', name: 'paper', number: 4, after: null } });
    expect((first.body as { query: string }).query).toContain('reviewThreads(first: 100, after: $after)');
    expect((requests[1] as RecordedRequest).body).toMatchObject({ variables: { after: 'c1' } });
  });

  it('resolves and reopens a thread with the GraphQL mutations', async () => {
    const thread = (resolved: boolean) => ({ id: 'PRRT_1', isResolved: resolved, viewerCanResolve: !resolved, viewerCanUnresolve: resolved, comments: { nodes: [{ databaseId: 11 }] } });
    const { gw, requests } = setup([
      graphql((req) => {
        const q = (req.body as { query: string }).query;
        if (q.includes('unresolveReviewThread')) return json({ data: { unresolveReviewThread: { thread: thread(false) } } });
        return json({ data: { resolveReviewThread: { thread: thread(true) } } });
      }),
    ]);
    expect(await gw.setThreadResolved(repo, 'PRRT_1', true)).toMatchObject({ resolved: true, canUnresolve: true });
    expect(await gw.setThreadResolved(repo, 'PRRT_1', false)).toMatchObject({ resolved: false, canResolve: true });
    const [resolve, reopen] = requests as [RecordedRequest, RecordedRequest];
    expect((resolve.body as { query: string }).query).toMatch(/mutation\s*\(\$id: ID!\)\s*\{\s*resolveReviewThread\(input: \{ threadId: \$id \}\)/);
    expect(resolve.body).toMatchObject({ variables: { id: 'PRRT_1' } });
    expect((reopen.body as { query: string }).query).toContain('unresolveReviewThread(input: { threadId: $id })');
  });
});

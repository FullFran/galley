import { describe, expect, it } from 'vitest';
import { AuthRequiredError, GatewayError, NotFoundError, PermissionError, TransientError } from '../domain';
import { CommentTooLargeError, InvalidCommentError, RateLimitedError, ThreadStatusError, type CommentThread } from '../domain/comments';
import { fakeFetch, json, on, type RecordedRequest } from '../test/fakeFetch';
import { createHttpCommentsGateway } from './http';

const API = 'https://galley-api.example.com';
const SHA = 'a'.repeat(40);

const threadJson = (over: Record<string, unknown> = {}) => ({
  id: 'abcdefghijklmno',
  repo_id: 42,
  repo_full_name: 'fran/paper',
  status: 'open',
  origin: 'source',
  anchor: {
    path: 'index.qmd',
    commit_sha: SHA,
    start_line: 3,
    end_line: 4,
    start_column: 2,
    end_column: 7,
    quote: { exact: 'hello', prefix: 'say ', suffix: ' world' },
  },
  position: { commit_sha: SHA, start_line: 3, end_line: 4, start_column: 2, end_column: 7, state: 'exact' },
  created_by: 'ana',
  created_at: '2026-10-28T10:00:00Z',
  updated_at: '2026-10-28T10:00:00Z',
  comments: [
    {
      id: 'c00000000000001',
      thread_id: 'abcdefghijklmno',
      author: { kind: 'human', login: 'ana' },
      mine: true,
      body: '<b>not html</b>',
      suggestion: { text: 'hi', base_sha: SHA },
      created_at: '2026-10-28T10:00:00Z',
    },
  ],
  ...over,
});

const gatewayWith = (routes: Parameters<typeof fakeFetch>[0]) => {
  const fake = fakeFetch(routes);
  return { gateway: createHttpCommentsGateway({ apiBase: `${API}/`, fetch: fake.fetch }), requests: fake.requests };
};

describe('HTTP comments gateway: requests', () => {
  it('lists threads with credentials, no CSRF header on GET, and an encoded query', async () => {
    const { gateway, requests } = gatewayWith([
      () => json({ threads: [threadJson()], truncated: false }),
    ]);
    const list = await gateway.listThreads(42, { path: 'sec/a b.qmd', status: 'open', at: SHA });
    const req = (requests[0] as RecordedRequest);
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`${API}/api/galley/repos/42/threads?path=sec%2Fa+b.qmd&status=open&at=${SHA}`);
    expect(req.credentials).toBe('include');
    expect(req.headers.get('X-Galley-CSRF')).toBeNull();
    expect(list.truncated).toBe(false);
    const thread = (list.threads[0] as CommentThread);
    expect(thread.anchor).toEqual({
      path: 'index.qmd',
      commitSha: SHA,
      startLine: 3,
      endLine: 4,
      startColumn: 2,
      endColumn: 7,
      quote: { exact: 'hello', prefix: 'say ', suffix: ' world' },
    });
    expect(thread.comments[0]).toMatchObject({ mine: true, body: '<b>not html</b>', suggestion: { text: 'hi', baseSha: SHA } });
  });

  it('creates a thread with the exact body shape and the CSRF header', async () => {
    const { gateway, requests } = gatewayWith([on('POST', `${API}/api/galley/repos/42/threads`, () => json(threadJson(), 201))]);
    await gateway.createThread(42, {
      path: 'index.qmd',
      commitSha: SHA,
      startLine: 3,
      endLine: 4,
      startColumn: 2,
      endColumn: 7,
      quote: { exact: 'hello', prefix: 'say ', suffix: ' world' },
      origin: 'preview',
      body: 'Why?',
      suggestion: 'hi',
    });
    const req = (requests[0] as RecordedRequest);
    expect(req.headers.get('X-Galley-CSRF')).toBe('1');
    expect(req.headers.get('Content-Type')).toBe('application/json');
    expect(req.credentials).toBe('include');
    expect(req.body).toEqual({
      path: 'index.qmd',
      commit_sha: SHA,
      start_line: 3,
      end_line: 4,
      start_column: 2,
      end_column: 7,
      quote: { exact: 'hello', prefix: 'say ', suffix: ' world' },
      origin: 'preview',
      body: 'Why?',
      suggestion: 'hi',
    });
  });

  it('omits columns and the suggestion when there are none', async () => {
    const { gateway, requests } = gatewayWith([() => json(threadJson(), 201)]);
    await gateway.createThread(42, {
      path: 'a.qmd',
      commitSha: SHA,
      startLine: 1,
      endLine: 1,
      quote: { exact: 'x', prefix: '', suffix: '' },
      origin: 'source',
      body: 'b',
    });
    expect(Object.keys((requests[0] as RecordedRequest).body as object).sort()).toEqual(
      ['body', 'commit_sha', 'end_line', 'origin', 'path', 'quote', 'start_line'].sort(),
    );
  });

  it('uses the documented routes for replies, edits, deletes, status and read markers', async () => {
    const comment = threadJson().comments[0];
    const { gateway, requests } = gatewayWith([
      on('POST', `${API}/api/galley/threads/abcdefghijklmno/comments`, () => json(comment, 201)),
      on('PATCH', `${API}/api/galley/comments/c00000000000001`, () => json(comment)),
      on('DELETE', `${API}/api/galley/comments/c00000000000001`, () => new Response(null, { status: 204 })),
      on('POST', `${API}/api/galley/threads/abcdefghijklmno/resolve`, () => json(threadJson({ status: 'resolved' }))),
      on('POST', `${API}/api/galley/threads/abcdefghijklmno/reopen`, () => json(threadJson())),
      on('POST', `${API}/api/galley/threads/abcdefghijklmno/read`, () => new Response(null, { status: 204 })),
      on('GET', `${API}/api/galley/repos/42/unread`, () => json({ repo_id: 42, threads: 1, comments: 2, by_thread: { abcdefghijklmno: 2 } })),
    ]);
    await gateway.reply('abcdefghijklmno', { body: 'ok' });
    await gateway.editComment('c00000000000001', { body: 'edited', suggestion: 'x' });
    await gateway.deleteComment('c00000000000001');
    expect((await gateway.resolve('abcdefghijklmno')).status).toBe('resolved');
    await gateway.reopen('abcdefghijklmno');
    await gateway.markRead('abcdefghijklmno');
    expect(await gateway.unread(42)).toEqual({ threads: 1, comments: 2, byThread: { abcdefghijklmno: 2 } });
    expect((requests[0] as RecordedRequest).body).toEqual({ body: 'ok' });
    expect((requests[1] as RecordedRequest).body).toEqual({ body: 'edited', suggestion: 'x' });
    for (const r of requests.filter((r) => r.method !== 'GET')) expect(r.headers.get('X-Galley-CSRF')).toBe('1');
  });

  it('refuses malformed ids before sending anything', async () => {
    const { gateway, requests } = gatewayWith([]);
    await expect(gateway.getThread('../auth/logout')).rejects.toBeInstanceOf(GatewayError);
    await expect(gateway.listThreads(-1)).rejects.toBeInstanceOf(GatewayError);
    await expect(gateway.deleteComment('ABC')).rejects.toBeInstanceOf(GatewayError);
    expect(requests).toHaveLength(0);
  });

  it('drops malformed threads and comments from a response', async () => {
    const bad = threadJson({ status: 'weird' });
    const badComment = threadJson({ comments: [{ id: 1, body: 2 }] });
    const { gateway } = gatewayWith([() => json({ threads: [bad, badComment, threadJson()], truncated: true })]);
    const list = await gateway.listThreads(42);
    expect(list.threads).toHaveLength(2);
    expect((list.threads[0] as CommentThread).comments).toHaveLength(0);
    expect(list.truncated).toBe(true);
  });
});

describe('HTTP comments gateway: errors', () => {
  const failing = (status: number, body: unknown = { error: 'x' }, headers: Record<string, string> = {}) =>
    gatewayWith([() => json(body, status, headers)]).gateway;

  it.each([
    [401, AuthRequiredError],
    [403, PermissionError],
    [404, NotFoundError],
    [409, ThreadStatusError],
    [413, CommentTooLargeError],
    [500, TransientError],
    [503, TransientError],
    [400, GatewayError],
  ])('maps %i', async (status, type) => {
    await expect(failing(status).resolve('abcdefghijklmno')).rejects.toBeInstanceOf(type);
  });

  it('maps 422 with the field the server named', async () => {
    const err = await failing(422, { error: 'Unprocessable Entity', field: 'quote.exact' })
      .reply('abcdefghijklmno', { body: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidCommentError);
    expect((err as InvalidCommentError).field).toBe('quote.exact');
  });

  it('maps 429 to a rate limit with Retry-After', async () => {
    const err = await failing(429, { error: 'Too Many Requests' }, { 'Retry-After': '2' })
      .reply('abcdefghijklmno', { body: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(2);
  });

  it('maps a network failure to a transient error', async () => {
    const gateway = createHttpCommentsGateway({
      apiBase: API,
      fetch: () => Promise.reject(new TypeError('offline')),
    });
    await expect(gateway.unread(42)).rejects.toBeInstanceOf(TransientError);
  });
});

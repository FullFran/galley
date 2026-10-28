import { describe, expect, it } from 'vitest';
import { AuthRequiredError, GatewayError, NotFoundError, PermissionError, TransientError } from '../domain';
import { RateLimitedError } from '../domain/comments';
import { fakeFetch, json, on, type Route } from '../test/fakeFetch';
import { ConfirmSelfError, createHttpDraftSharesGateway, DuplicateEntryError, InvalidAdminInputError } from './api';
import { createHttpAdminGateway } from './http';

const API = 'https://galley-api.example.com';
const R = `${API}/api/galley/repos/42`;
const UID = 'u00000000000001';
const SID = 's00000000000001';

const person = (over: Record<string, unknown> = {}) => ({
  user_id: UID,
  login: 'ana',
  github_id: 7,
  permission: 'write',
  first_seen: '2026-10-01T10:00:00Z',
  last_seen: '2026-10-28T10:00:00Z',
  blocked: false,
  drafts: { count: 2, bytes: 2048, oldest_updated_at: '2026-10-20T10:00:00Z', newest_updated_at: '2026-10-27T10:00:00Z' },
  ...over,
});

const share = (over: Record<string, unknown> = {}) => ({
  id: SID,
  repo_id: 42,
  path: 'chapters/intro.qmd',
  owner: { user_id: UID, login: 'ana' },
  created_at: '2026-10-28T10:00:00Z',
  expires_at: '2026-10-29T10:00:00Z',
  ...over,
});

const gw = (routes: Route[]) => {
  const f = fakeFetch(routes);
  return {
    admin: createHttpAdminGateway({ apiBase: API, fetch: f.fetch }),
    shares: createHttpDraftSharesGateway({ apiBase: `${API}/`, fetch: f.fetch }),
    requests: f.requests,
  };
};

describe('admin gateway requests', () => {
  it('reads people with the session cookie and no CSRF header, dropping malformed rows', async () => {
    const { admin, requests } = gw([on('GET', `${R}/admin/people`, () => json({ people: [person(), { login: 'x' }, person({ permission: 'root' })] }))]);
    const people = await admin.people(42);
    expect(people).toEqual([
      {
        userId: UID,
        login: 'ana',
        githubId: 7,
        permission: 'write',
        firstSeen: '2026-10-01T10:00:00Z',
        lastSeen: '2026-10-28T10:00:00Z',
        blocked: false,
        drafts: { count: 2, bytes: 2048, oldest: '2026-10-20T10:00:00Z', newest: '2026-10-27T10:00:00Z' },
      },
    ]);
    expect(requests[0]?.credentials).toBe('include');
    expect(requests[0]?.headers.get('X-Galley-CSRF')).toBeNull();
  });

  it('revokes sessions with CSRF and confirm_self only when asked', async () => {
    const { admin, requests } = gw([on('POST', `${R}/admin/people/${UID}/revoke-sessions`, () => new Response(null, { status: 204 }))]);
    await admin.revokeSessions(42, UID, false);
    await admin.revokeSessions(42, UID, true);
    expect(requests.map((r) => r.body)).toEqual([{}, { confirm_self: true }]);
    expect(requests[0]?.headers.get('X-Galley-CSRF')).toBe('1');
    expect(requests[0]?.headers.get('Content-Type')).toBe('application/json');
  });

  it('refuses malformed ids before any request', async () => {
    const { admin, requests } = gw([]);
    await expect(admin.revokeSessions(42, '../x', false)).rejects.toBeInstanceOf(GatewayError);
    await expect(admin.disallow(42, 'a/b')).rejects.toBeInstanceOf(GatewayError);
    await expect(admin.sharedDraft(42, 'nope')).rejects.toBeInstanceOf(GatewayError);
    await expect(admin.people(0)).rejects.toBeInstanceOf(GatewayError);
    expect(requests).toHaveLength(0);
  });

  it('adds allowlist entries by login and optional id, and removes them', async () => {
    const { admin, requests } = gw([
      on('POST', `${R}/admin/allowlist`, () => json({ id: 'a00000000000001', login: 'bob', github_id: 9, created_at: '2026-10-28T10:00:00Z' }, 201)),
      on('DELETE', `${R}/admin/allowlist/a00000000000001`, () => new Response(null, { status: 204 })),
      on('GET', `${R}/admin/allowlist`, () => json({ entries: [{ id: 'a00000000000002', login: 'eve', created_at: '2026-10-28T10:00:00Z' }] })),
    ]);
    expect(await admin.allow(42, { login: 'bob', githubId: 9 })).toEqual({ id: 'a00000000000001', login: 'bob', githubId: 9, createdAt: '2026-10-28T10:00:00Z' });
    await admin.allow(42, { login: 'carol' });
    await admin.disallow(42, 'a00000000000001');
    expect(await admin.allowlist(42)).toEqual([{ id: 'a00000000000002', login: 'eve', createdAt: '2026-10-28T10:00:00Z' }]);
    expect(requests.map((r) => r.body)).toEqual([{ login: 'bob', github_id: 9 }, { login: 'carol' }, undefined, undefined]);
    expect(requests[2]?.headers.get('X-Galley-CSRF')).toBe('1');
  });

  it('reads shared drafts, one shared draft with content, and the audit log', async () => {
    const { admin } = gw([
      on('GET', `${R}/admin/shared-drafts`, () => json({ shared_drafts: [share({ size: 12, updated_at: '2026-10-28T11:00:00Z' })] })),
      on('GET', `${R}/admin/shared-drafts/${SID}`, () =>
        json({
          share: share(),
          read_only: true,
          path: 'chapters/intro.qmd',
          base_sha: 'b'.repeat(40),
          size: 12,
          updated_at: '2026-10-28T11:00:00Z',
          content: '<b>hi</b>',
        }),
      ),
      on('GET', `${R}/admin/audit`, () =>
        json({
          entries: [
            { id: 'e00000000000001', actor: { user_id: UID, login: 'fran' }, action: 'allowlist.add', target: 'allow:x', at: '2026-10-28T10:00:00Z' },
            { id: 1 },
          ],
        }),
      ),
    ]);
    const list = await admin.sharedDrafts(42);
    expect(list[0]).toMatchObject({ id: SID, path: 'chapters/intro.qmd', owner: { userId: UID, login: 'ana' }, size: 12, expiresAt: '2026-10-29T10:00:00Z' });
    const one = await admin.sharedDraft(42, SID);
    expect(one).toMatchObject({ path: 'chapters/intro.qmd', content: '<b>hi</b>', size: 12, share: { id: SID } });
    expect(await admin.audit(42)).toEqual([
      { id: 'e00000000000001', actor: { userId: UID, login: 'fran' }, action: 'allowlist.add', target: 'allow:x', at: '2026-10-28T10:00:00Z' },
    ]);
  });

  it('refuses a shared draft answer that is not read only', async () => {
    const { admin } = gw([on('GET', `${R}/admin/shared-drafts/${SID}`, () => json({ share: share(), read_only: false, path: 'a', content: 'x' }))]);
    await expect(admin.sharedDraft(42, SID)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('admin gateway errors', () => {
  const failing = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => gw([() => json(body, status, headers)]).admin;

  it.each([
    [401, AuthRequiredError],
    [403, PermissionError],
    [404, NotFoundError],
    [409, DuplicateEntryError],
    [503, TransientError],
    [400, GatewayError],
  ])('maps %i', async (status, type) => {
    await expect(failing(status).people(42)).rejects.toBeInstanceOf(type);
  });

  it('maps 422 confirm_self to its own error, other 422s with the field', async () => {
    await expect(failing(422, { field: 'confirm_self' }).revokeSessions(42, UID, false)).rejects.toBeInstanceOf(ConfirmSelfError);
    const err = await failing(422, { field: 'allowlist' })
      .allow(42, { login: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidAdminInputError);
    expect((err as InvalidAdminInputError).field).toBe('allowlist');
  });

  it('maps 429 with Retry-After, and an unreachable API to a transient error', async () => {
    const err = await failing(429, {}, { 'Retry-After': '9' })
      .audit(42)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(9);
    const down = createHttpAdminGateway({ apiBase: API, fetch: () => Promise.reject(new TypeError('offline')) });
    await expect(down.people(42)).rejects.toBeInstanceOf(TransientError);
  });

  it('treats malformed list bodies as errors', async () => {
    await expect(failing(200, { nope: [] }).allowlist(42)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('owner draft shares', () => {
  it('shares and stops sharing with each path segment encoded', async () => {
    const { shares, requests } = gw([
      on('POST', `${R}/draft-shares/chapters/my%20intro.qmd`, () => json(share({ path: 'chapters/my intro.qmd' }), 201)),
      on('DELETE', `${R}/draft-shares/chapters/my%20intro.qmd`, () => new Response(null, { status: 204 })),
    ]);
    expect((await shares.share(42, 'chapters/my intro.qmd')).path).toBe('chapters/my intro.qmd');
    await shares.unshare(42, 'chapters/my intro.qmd');
    expect(requests.map((r) => [r.method, r.body, r.headers.get('X-Galley-CSRF')])).toEqual([
      ['POST', {}, '1'],
      ['DELETE', undefined, '1'],
    ]);
  });

  it('lists my shares and whether a server draft exists', async () => {
    const { shares } = gw([
      on('GET', `${R}/draft-shares`, () => json({ shares: [share(), { id: 'bad' }] })),
      on('GET', `${R}/drafts`, () => json({ drafts: [{ path: 'chapters/intro.qmd', size: 3, updated_at: '2026-10-28T10:00:00Z' }] })),
    ]);
    expect((await shares.list(42)).map((s) => s.id)).toEqual([SID]);
    expect(await shares.hasDraft(42, 'chapters/intro.qmd')).toBe(true);
    expect(await shares.hasDraft(42, 'index.qmd')).toBe(false);
  });

  it('treats stopping a share that already ended as done', async () => {
    const { shares } = gw([on('DELETE', `${R}/draft-shares/a.qmd`, () => json({}, 404))]);
    await expect(shares.unshare(42, 'a.qmd')).resolves.toBeUndefined();
  });

  it('refuses unsafe paths before any request', async () => {
    const { shares, requests } = gw([]);
    for (const bad of ['', '../a', 'a//b', '/a', 'a/./b']) await expect(shares.share(42, bad)).rejects.toBeInstanceOf(GatewayError);
    expect(requests).toHaveLength(0);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRequiredError, TransientError } from '../domain';
import { fakeFetch, json, on, type RecordedRequest } from '../test/fakeFetch';
import { createSession } from './session';

const API = 'https://api.example.test';
const TOKEN_URL = `${API}/api/galley/auth/token`;

function tokenResponse(token: string, expiresAt: string) {
  return json({ access_token: token, expires_at: expiresAt });
}

describe('session client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests a token with credentials, the CSRF header and the repository id', async () => {
    const { fetch, requests } = fakeFetch([
      on('POST', TOKEN_URL, () => tokenResponse('t1', '2030-01-01T00:00:00Z')),
    ]);
    const session = createSession({ apiBase: API, fetch, now: () => 0 });

    await expect(session.getAccessToken(42)).resolves.toBe('t1');

    const req = requests[0] as RecordedRequest;
    expect(req.credentials).toBe('include');
    expect(req.headers.get('X-Galley-CSRF')).toBe('1');
    expect(req.headers.get('Content-Type')).toBe('application/json');
    expect(req.body).toEqual({ repository_id: 42 });
  });

  it('caches the token until shortly before it expires', async () => {
    let n = 0;
    const { fetch, requests } = fakeFetch([
      on('POST', TOKEN_URL, () => tokenResponse(`t${++n}`, '1970-01-01T01:00:00Z')),
    ]);
    let clock = 0;
    const session = createSession({ apiBase: API, fetch, now: () => clock });

    expect(await session.getAccessToken()).toBe('t1');
    clock = 30 * 60_000;
    expect(await session.getAccessToken()).toBe('t1');
    clock = 60 * 60_000 - 30_000; // inside the refresh margin
    expect(await session.getAccessToken()).toBe('t2');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toBeUndefined();
  });

  it('does not reuse a token issued for another repository', async () => {
    let n = 0;
    const { fetch, requests } = fakeFetch([
      on('POST', TOKEN_URL, () => tokenResponse(`t${++n}`, '2030-01-01T00:00:00Z')),
    ]);
    const session = createSession({ apiBase: API, fetch, now: () => 0 });

    await session.getAccessToken(1);
    await session.getAccessToken(2);
    await session.getAccessToken(2);
    expect(requests.map((r) => r.body)).toEqual([{ repository_id: 1 }, { repository_id: 2 }]);
  });

  it('de-duplicates concurrent calls into one request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetch, requests } = fakeFetch([
      on('POST', TOKEN_URL, async () => {
        await gate;
        return tokenResponse('t1', '2030-01-01T00:00:00Z');
      }),
    ]);
    const session = createSession({ apiBase: API, fetch, now: () => 0 });

    const all = Promise.all([session.getAccessToken(), session.getAccessToken(), session.getAccessToken()]);
    release();
    expect(await all).toEqual(['t1', 't1', 't1']);
    expect(requests).toHaveLength(1);
  });

  it('fetches a new token after invalidate', async () => {
    let n = 0;
    const { fetch } = fakeFetch([
      on('POST', TOKEN_URL, () => tokenResponse(`t${++n}`, '2030-01-01T00:00:00Z')),
    ]);
    const session = createSession({ apiBase: API, fetch, now: () => 0 });

    await session.getAccessToken();
    session.invalidate();
    expect(await session.getAccessToken()).toBe('t2');
  });

  it('maps 401 to AuthRequiredError and 503 or network failure to TransientError', async () => {
    const statuses = [401, 503];
    const { fetch } = fakeFetch([
      on('POST', TOKEN_URL, () => {
        const status = statuses.shift();
        if (status === undefined) throw new TypeError('Failed to fetch');
        return json({ error: 'x' }, status);
      }),
    ]);
    const session = createSession({ apiBase: API, fetch, now: () => 0 });

    await expect(session.getAccessToken()).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TransientError);
    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TransientError);
  });

  it('never writes the token to browser storage', async () => {
    const touched: string[] = [];
    const storage = (name: string) =>
      new Proxy(
        {},
        {
          get: (_t, prop) => {
            touched.push(`${name}.${String(prop)}`);
            return () => undefined;
          },
        },
      );
    vi.stubGlobal('localStorage', storage('localStorage'));
    vi.stubGlobal('sessionStorage', storage('sessionStorage'));
    vi.stubGlobal('indexedDB', storage('indexedDB'));
    const { fetch } = fakeFetch([
      on('POST', TOKEN_URL, () => tokenResponse('secret-token', '2030-01-01T00:00:00Z')),
    ]);
    const session = createSession({ apiBase: API, fetch, now: () => 0 });

    await session.getAccessToken();
    await session.getAccessToken();
    expect(touched).toEqual([]);
  });

  it('builds the login URL and logs out with the CSRF header', async () => {
    const { fetch, requests } = fakeFetch([
      on('POST', `${API}/api/galley/auth/logout`, () => new Response(null, { status: 204 })),
      on('POST', TOKEN_URL, () => tokenResponse('t1', '2030-01-01T00:00:00Z')),
    ]);
    const session = createSession({ apiBase: `${API}/`, fetch, now: () => 0 });

    expect(session.loginUrl()).toBe(`${API}/api/galley/auth/login`);
    await session.getAccessToken();
    await session.logout();
    const logout = requests[1] as RecordedRequest;
    expect(logout.url).toBe(`${API}/api/galley/auth/logout`);
    expect(logout.credentials).toBe('include');
    expect(logout.headers.get('X-Galley-CSRF')).toBe('1');
    // The cached token is dropped on logout.
    await session.getAccessToken();
    expect(requests).toHaveLength(3);
  });

  it('does not cache a token whose fetch was in flight during logout', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let n = 0;
    const { fetch, requests } = fakeFetch([
      on('POST', `${API}/api/galley/auth/logout`, () => new Response(null, { status: 204 })),
      on('POST', TOKEN_URL, async () => {
        const token = `t${++n}`;
        if (n === 1) await gate;
        return tokenResponse(token, '2030-01-01T00:00:00Z');
      }),
    ]);
    const session = createSession({ apiBase: API, fetch, now: () => 0 });

    const stale = session.getAccessToken();
    await session.logout();
    // A new call after logout must not join the stale in-flight request.
    const fresh = session.getAccessToken();
    release();
    await stale;
    expect(await fresh).toBe('t2');
    expect(await session.getAccessToken()).toBe('t2');
    expect(requests.filter((r) => r.url === TOKEN_URL)).toHaveLength(2);
  });

  it('reports a malformed token response as TransientError', async () => {
    const { fetch } = fakeFetch([
      on('POST', TOKEN_URL, () => new Response('<html>', { status: 200 })),
    ]);
    const session = createSession({ apiBase: API, fetch, now: () => 0 });

    await expect(session.getAccessToken()).rejects.toBeInstanceOf(TransientError);
  });
});

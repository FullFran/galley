import { AuthRequiredError, GatewayError, TransientError } from '../domain';

/** Default API base for local development (`go run . serve`). */
export const DEFAULT_API_BASE = 'http://127.0.0.1:8090';

/** Tokens are refreshed this long before `expires_at`. */
const REFRESH_MARGIN_MS = 60_000;

export interface Session {
  /** Returns a GitHub user access token, optionally scoped to one repository. */
  getAccessToken(repositoryId?: number): Promise<string>;
  /** Drops the cached token so the next call fetches a new one. */
  invalidate(): void;
  /** URL for a top-level navigation that starts the GitHub sign-in. */
  loginUrl(): string;
  logout(): Promise<void>;
}

export interface SessionOptions {
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface CachedToken {
  key: string;
  token: string;
  expiresAt: number;
}

export function apiBaseFromEnv(): string {
  return import.meta.env.VITE_API_BASE || DEFAULT_API_BASE;
}

/**
 * Session client for the galley API. The access token is kept only in this
 * closure (memory); it is never written to any browser storage.
 */
export function createSession(options: SessionOptions = {}): Session {
  const base = (options.apiBase ?? apiBaseFromEnv()).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  let cached: CachedToken | undefined;
  const inflight = new Map<string, Promise<string>>();
  // Bumped by invalidate/logout so a fetch already in flight cannot refill the cache.
  let generation = 0;
  const reset = () => {
    generation++;
    cached = undefined;
    inflight.clear();
  };

  const post = async (path: string, body?: unknown): Promise<Response> => {
    try {
      return await doFetch(`${base}/api/galley/auth/${path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Galley-CSRF': '1', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new TransientError('galley API unreachable');
    }
  };

  const fetchToken = async (key: string, repositoryId?: number): Promise<string> => {
    const started = generation;
    const res = await post('token', repositoryId === undefined ? undefined : { repository_id: repositoryId });
    if (res.status === 401) throw new AuthRequiredError('sign in required');
    if (res.status >= 500) throw new TransientError(`token request failed (${res.status})`);
    if (!res.ok) throw new GatewayError(`token request rejected (${res.status})`);
    const data = (await res.json().catch(() => {
      throw new TransientError('malformed token response');
    })) as { access_token?: unknown; expires_at?: unknown };
    const expiresAt = Date.parse(String(data.expires_at));
    if (typeof data.access_token !== 'string' || Number.isNaN(expiresAt)) {
      throw new GatewayError('malformed token response');
    }
    if (started === generation) cached = { key, token: data.access_token, expiresAt };
    return data.access_token;
  };

  return {
    getAccessToken(repositoryId) {
      const key = repositoryId === undefined ? '*' : String(repositoryId);
      if (cached?.key === key && cached.expiresAt - REFRESH_MARGIN_MS > now()) {
        return Promise.resolve(cached.token);
      }
      let pending = inflight.get(key);
      if (!pending) {
        const request: Promise<string> = fetchToken(key, repositoryId).finally(() => {
          if (inflight.get(key) === request) inflight.delete(key);
        });
        pending = request;
        inflight.set(key, request);
      }
      return pending;
    },
    invalidate() {
      reset();
    },
    loginUrl() {
      return `${base}/api/galley/auth/login`;
    },
    async logout() {
      reset();
      const res = await post('logout');
      if (!res.ok && res.status !== 401) throw new GatewayError(`logout failed (${res.status})`);
    },
  };
}

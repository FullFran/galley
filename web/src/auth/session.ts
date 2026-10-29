import { AuthRequiredError, GatewayError, TransientError } from '../domain';

/** Default API base for local development (`go run . serve`). */
export const DEFAULT_API_BASE = 'http://127.0.0.1:8090';

/** Tokens are refreshed this long before `expires_at` (less than the server's 5-minute reuse margin). */
const REFRESH_MARGIN_MS = 60_000;

export interface Session {
  /** Returns the user's GitHub access token (one per user, shared by every tab and device). */
  getAccessToken(): Promise<string>;
  /**
   * With `token`: GitHub rejected that token, so the next call asks for a new
   * one, unless a newer token already replaced it. Without: drops everything.
   */
  invalidate(token?: string): void;
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
  // One request at a time: every caller, including parallel calls that just
  // saw GitHub answer 401, shares it.
  let inflight: Promise<string> | undefined;
  // The token GitHub refused, reported on the next request so the server
  // refreshes instead of handing it out again.
  let rejected: string | undefined;
  // Bumped by a full invalidate/logout so a fetch already in flight cannot refill the cache.
  let generation = 0;
  const reset = () => {
    generation++;
    cached = undefined;
    inflight = undefined;
    rejected = undefined;
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

  const fetchToken = async (): Promise<string> => {
    const started = generation;
    const reported = rejected;
    const res = await post('token', reported === undefined ? undefined : { rejected: reported });
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
    if (started === generation) {
      cached = { token: data.access_token, expiresAt };
      if (rejected === reported) rejected = undefined;
    }
    return data.access_token;
  };

  return {
    getAccessToken() {
      if (cached && cached.expiresAt - REFRESH_MARGIN_MS > now()) return Promise.resolve(cached.token);
      if (!inflight) {
        const request: Promise<string> = fetchToken().finally(() => {
          if (inflight === request) inflight = undefined;
        });
        inflight = request;
      }
      return inflight;
    },
    invalidate(token) {
      if (token === undefined) return reset();
      // Only the current token can be rejected: a report about an older one
      // (another call already got a new token) changes nothing.
      if (cached?.token !== token) return;
      cached = undefined;
      rejected = token;
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

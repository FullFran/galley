import { AuthRequiredError, GatewayError, NotFoundError, PermissionError, TransientError } from '../domain';
import { apiBaseFromEnv } from '../auth/session';
import { InvalidCommentError, RateLimitedError } from '../domain/comments';

// A small client for galley's own API (README, "Comments API" middleware):
// the session cookie (credentials: 'include'), the exact Origin the browser
// sends, and `X-Galley-CSRF: 1` on every state-changing request. Used by the
// drafts and chat gateways; errors map to the domain errors.

export interface GalleyApiOptions {
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): v is string => typeof v === 'string';

/** 413: the request body was too large. */
export class PayloadTooLargeError extends GatewayError {}

export interface SendOptions {
  body?: Json;
  headers?: Record<string, string>;
  /** Statuses returned to the caller instead of thrown. */
  allow?: number[];
}

export interface GalleyApi {
  readonly base: string;
  send(method: string, path: string, options?: SendOptions): Promise<{ status: number; data: unknown }>;
}

async function toError(res: Response, what: string): Promise<GatewayError> {
  const body = (await res.json().catch(() => ({}))) as unknown;
  const detail = `galley ${what} ${res.status}`;
  switch (res.status) {
    case 401:
      return new AuthRequiredError('sign in required');
    case 403:
      return new PermissionError(detail);
    case 404:
      return new NotFoundError(detail);
    case 413:
      return new PayloadTooLargeError(detail);
    case 422:
      return new InvalidCommentError(detail, isRecord(body) && str(body.field) ? body.field.slice(0, 64) : undefined);
    case 429: {
      const after = Number(res.headers.get('Retry-After'));
      return new RateLimitedError(detail, Number.isFinite(after) && after > 0 ? Math.min(after, 3600) : 2);
    }
  }
  return res.status >= 500 ? new TransientError(detail) : new GatewayError(detail);
}

export function createGalleyApi(what: string, options: GalleyApiOptions = {}): GalleyApi {
  const base = `${(options.apiBase ?? apiBaseFromEnv()).replace(/\/+$/, '')}/api/galley`;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    base,
    async send(method, path, { body, headers: extra = {}, allow = [] } = {}) {
      const headers: Record<string, string> = { ...extra };
      if (method !== 'GET') headers['X-Galley-CSRF'] = '1';
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          credentials: 'include',
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new TransientError('galley API unreachable');
      }
      if (!res.ok && !allow.includes(res.status)) throw await toError(res, what);
      if (res.status === 204) return { status: 204, data: undefined };
      try {
        return { status: res.status, data: (await res.json()) as unknown };
      } catch {
        if (!res.ok) return { status: res.status, data: undefined };
        throw new TransientError('malformed galley response');
      }
    },
  };
}

export function checkRepo(repoId: number): number {
  if (!Number.isSafeInteger(repoId) || repoId <= 0) throw new GatewayError('malformed repository id');
  return repoId;
}

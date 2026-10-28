import { AuthRequiredError, GatewayError, NotFoundError, PermissionError, TransientError } from '../domain';
import { RateLimitedError } from '../domain/comments';
import { apiBaseFromEnv } from '../auth/session';

// The galley API shared by the admin panel and the owner's side of draft
// sharing (README, "Admin API"): the session cookie, `X-Galley-CSRF: 1` on
// every write, responses checked field by field. This module stays small: the
// owner's share toggle ships in the main bundle, the admin panel (./http) is
// loaded only when an admin opens it.

export interface GalleyApiOptions {
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

/** 409: the allowlist already has that person. */
export class DuplicateEntryError extends GatewayError {}
/** 422 `confirm_self`: revoking your own sessions needs an explicit confirmation. */
export class ConfirmSelfError extends GatewayError {}
/** Any other 422, with the field the server named. */
export class InvalidAdminInputError extends GatewayError {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): v is string => typeof v === 'string';
export const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** PocketBase record ids. */
export const ID = /^[a-z0-9]{15}$/;

export function checkId(id: string): string {
  if (!ID.test(id)) throw new GatewayError('malformed id');
  return id;
}

export function checkRepo(repoId: number): number {
  if (!Number.isSafeInteger(repoId) || repoId <= 0) throw new GatewayError('malformed repository id');
  return repoId;
}

/** A repository path as URL segments; refuses empty, absolute and dot segments. */
export function encodePath(path: string): string {
  const parts = path.split('/');
  // eslint-disable-next-line no-control-regex
  if (path === '' || parts.some((p) => p === '' || p === '.' || p === '..' || /[\\\u0000-\u001f\u007f]/.test(p))) {
    throw new GatewayError('malformed path');
  }
  return parts.map(encodeURIComponent).join('/');
}

async function toError(res: Response): Promise<GatewayError> {
  const body = (await res.json().catch(() => ({}))) as unknown;
  const field = isRecord(body) && str(body.field) ? body.field.slice(0, 64) : undefined;
  const detail = `galley admin ${res.status}`;
  switch (res.status) {
    case 401:
      return new AuthRequiredError('sign in required');
    case 403:
      return new PermissionError(detail);
    case 404:
      return new NotFoundError(detail);
    case 409:
      return new DuplicateEntryError(detail);
    case 422:
      return field === 'confirm_self' ? new ConfirmSelfError(detail) : new InvalidAdminInputError(detail, field);
    case 429: {
      const after = Number(res.headers.get('Retry-After'));
      return new RateLimitedError(detail, Number.isFinite(after) && after > 0 ? Math.min(after, 3600) : 2);
    }
  }
  return res.status >= 500 ? new TransientError(detail) : new GatewayError(detail);
}

export type Send = (method: string, path: string, body?: Json) => Promise<unknown>;

/** A request function for `/api/galley`; `path` starts with `/`. */
export function galleyApi(options: GalleyApiOptions = {}): Send {
  const base = `${(options.apiBase ?? apiBaseFromEnv()).replace(/\/+$/, '')}/api/galley`;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (method, path, body) => {
    const headers: Record<string, string> = {};
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
    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined;
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new TransientError('malformed galley response');
    }
  };
}

/** A share grant: the owner lets the repository's admins read one draft. */
export interface DraftShare {
  id: string;
  repoId: number;
  path: string;
  owner: { userId: string; login?: string };
  createdAt: string;
  expiresAt: string;
  /** Admin listing only: the draft's current size and update time. */
  size?: number;
  updatedAt?: string;
}

export function parseShare(v: unknown): DraftShare | undefined {
  if (!isRecord(v) || !str(v.id) || !ID.test(v.id) || typeof v.repo_id !== 'number' || !str(v.path) || v.path === '') return undefined;
  if (!str(v.created_at) || !str(v.expires_at) || !isRecord(v.owner) || !str(v.owner.user_id)) return undefined;
  const share: DraftShare = {
    id: v.id,
    repoId: v.repo_id,
    path: v.path,
    owner: { userId: v.owner.user_id },
    createdAt: v.created_at,
    expiresAt: v.expires_at,
  };
  if (str(v.owner.login) && v.owner.login !== '') share.owner.login = v.owner.login;
  if (count(v.size)) share.size = v.size;
  if (str(v.updated_at) && v.updated_at !== '') share.updatedAt = v.updated_at;
  return share;
}

/** The owner's side of draft sharing. */
export interface DraftSharesGateway {
  /** Your active grants in the repository. */
  list(repoId: number): Promise<DraftShare[]>;
  /** Shares your draft at `path` with the repository's admins for 24 hours (renews). */
  share(repoId: number, path: string): Promise<DraftShare>;
  /** Stops sharing at once; done when nothing was shared either. */
  unshare(repoId: number, path: string): Promise<void>;
  /** Whether you have a server draft at `path` (metadata only). */
  hasDraft(repoId: number, path: string): Promise<boolean>;
}

export function createHttpDraftSharesGateway(options: GalleyApiOptions = {}): DraftSharesGateway {
  const send = galleyApi(options);
  return {
    async list(repoId) {
      const data = await send('GET', `/repos/${checkRepo(repoId)}/draft-shares`);
      if (!isRecord(data) || !Array.isArray(data.shares)) throw new GatewayError('malformed share list');
      return data.shares.map(parseShare).filter((s): s is DraftShare => s !== undefined);
    },
    async share(repoId, path) {
      const s = parseShare(await send('POST', `/repos/${checkRepo(repoId)}/draft-shares/${encodePath(path)}`, {}));
      if (!s) throw new GatewayError('malformed share');
      return s;
    },
    async unshare(repoId, path) {
      try {
        await send('DELETE', `/repos/${checkRepo(repoId)}/draft-shares/${encodePath(path)}`);
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
    },
    async hasDraft(repoId, path) {
      const data = await send('GET', `/repos/${checkRepo(repoId)}/drafts`);
      if (!isRecord(data) || !Array.isArray(data.drafts)) throw new GatewayError('malformed draft list');
      return data.drafts.some((d) => isRecord(d) && d.path === path);
    },
  };
}

import { GatewayError, NotFoundError } from '../domain';
import { checkRepo, createGalleyApi, isRecord, str, type GalleyApiOptions } from '../galley/api';

// The drafts API (README, "Drafts API"): one private working copy per user,
// repository and path. A PUT without a version only creates; a replace sends
// the version last seen as If-Match, and 409 answers with the current
// metadata (or null when it is gone), so no device overwrites a newer draft.

export interface DraftMeta {
  path: string;
  baseSha: string;
  baseRef?: string;
  device?: string;
  size: number;
  updatedAt: string;
  etag: string;
}

export interface ServerDraft extends DraftMeta {
  content: string;
}

export interface DraftInput {
  baseSha: string;
  device: string;
  content: string;
}

/** 409: the server copy changed (another device) or was deleted; nothing was written. */
export class DraftConflictError extends GatewayError {
  readonly current: DraftMeta | null;

  constructor(message: string, current: DraftMeta | null) {
    super(message);
    this.current = current;
  }
}

export interface DraftsGateway {
  list(repoId: number): Promise<DraftMeta[]>;
  get(repoId: number, path: string): Promise<ServerDraft>;
  /** Creates (no `etag`) or replaces the draft last seen at `etag`. */
  put(repoId: number, path: string, input: DraftInput, etag?: string): Promise<DraftMeta>;
  /** Deletes one draft; one that is already gone is fine. */
  remove(repoId: number, path: string): Promise<void>;
  /** Deletes all of the user's drafts in the repository. */
  removeAll(repoId: number): Promise<number>;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function parseDraftMeta(v: unknown): DraftMeta | undefined {
  if (!isRecord(v) || !str(v.path) || !str(v.base_sha) || !SHA.test(v.base_sha) || !str(v.updated_at) || !str(v.etag)) return undefined;
  if (typeof v.size !== 'number' || !Number.isSafeInteger(v.size) || v.size < 0) return undefined;
  const m: DraftMeta = { path: v.path, baseSha: v.base_sha, size: v.size, updatedAt: v.updated_at, etag: v.etag };
  if (str(v.base_ref) && v.base_ref) m.baseRef = v.base_ref;
  if (str(v.device) && v.device) m.device = v.device.slice(0, 64);
  return m;
}

/** The URL path of a repository-relative file: each segment encoded; anything unsafe is refused. */
export function draftUrlPath(path: string): string {
  const segments = path.split('/');
  // eslint-disable-next-line no-control-regex
  if (!path || path.length > 512 || /[\\\u0000-\u001f\u007f]/.test(path) || segments.some((s) => s === '' || s === '.' || s === '..'))
    throw new GatewayError('malformed draft path');
  return segments.map(encodeURIComponent).join('/');
}

export function createHttpDraftsGateway(options: GalleyApiOptions = {}): DraftsGateway {
  const api = createGalleyApi('drafts', options);
  const at = (repoId: number, path?: string) => `/repos/${checkRepo(repoId)}/drafts${path === undefined ? '' : `/${draftUrlPath(path)}`}`;
  const meta = (v: unknown): DraftMeta => {
    const m = parseDraftMeta(v);
    if (!m) throw new GatewayError('malformed draft');
    return m;
  };
  return {
    async list(repoId) {
      const { data } = await api.send('GET', at(repoId));
      if (!isRecord(data) || !Array.isArray(data.drafts)) throw new GatewayError('malformed draft list');
      return data.drafts.map(parseDraftMeta).filter((m): m is DraftMeta => m !== undefined);
    },
    async get(repoId, path) {
      const { data } = await api.send('GET', at(repoId, path));
      if (!isRecord(data) || !str(data.content)) throw new GatewayError('malformed draft');
      return { ...meta(data), content: data.content };
    },
    async put(repoId, path, input, etag) {
      const { status, data } = await api.send('PUT', at(repoId, path), {
        body: { base_sha: input.baseSha, device: input.device, content: input.content },
        headers: etag === undefined ? {} : { 'If-Match': etag },
        allow: [409],
      });
      if (status === 409) {
        const current = isRecord(data) && data.current !== null ? (parseDraftMeta(data.current) ?? null) : null;
        throw new DraftConflictError('draft changed elsewhere', current);
      }
      return meta(data);
    },
    async remove(repoId, path) {
      try {
        await api.send('DELETE', at(repoId, path));
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
    },
    async removeAll(repoId) {
      const { data } = await api.send('DELETE', at(repoId));
      return isRecord(data) && typeof data.deleted === 'number' ? data.deleted : 0;
    },
  };
}

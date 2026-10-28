import { AuthRequiredError, GatewayError, NotFoundError, PermissionError, TransientError } from '../domain';
import { apiBaseFromEnv } from '../auth/session';
import {
  CommentTooLargeError,
  InvalidCommentError,
  RateLimitedError,
  ThreadStatusError,
  type CommentAuthor,
  type CommentInput,
  type CommentThread,
  type CommentsGateway,
  type LineRange,
  type NewThread,
  type ThreadComment,
  type ThreadList,
  type UnreadCounts,
} from '../domain/comments';

// CommentsGateway over the galley API (README, "Comments API"): the session
// cookie (credentials: 'include'), the exact Origin the browser sends, and
// `X-Galley-CSRF: 1` on every state-changing request. Responses are checked
// field by field; anything malformed is dropped rather than shown. All text
// stays untrusted (rendered as plain text by the UI).

export interface HttpCommentsOptions {
  apiBase?: string;
  fetch?: typeof globalThis.fetch;
}

const ID = /^[a-z0-9]{15}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const line = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const column = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : undefined);

function checkId(id: string): string {
  if (!ID.test(id)) throw new GatewayError('malformed comment id');
  return id;
}

function checkRepo(repoId: number): number {
  if (!Number.isSafeInteger(repoId) || repoId <= 0) throw new GatewayError('malformed repository id');
  return repoId;
}

function parseRange(v: Json): LineRange | undefined {
  if (!line(v.start_line) || !line(v.end_line) || v.end_line < v.start_line) return undefined;
  const range: LineRange = { startLine: v.start_line, endLine: v.end_line };
  const start = column(v.start_column);
  const end = column(v.end_column);
  if (start !== undefined && end !== undefined) {
    range.startColumn = start;
    range.endColumn = end;
  }
  return range;
}

function parseAuthor(v: unknown): CommentAuthor | undefined {
  if (!isRecord(v) || (v.kind !== 'human' && v.kind !== 'ai') || !str(v.login)) return undefined;
  const author: CommentAuthor = { kind: v.kind, login: v.login };
  const client = optStr(v.ai_client);
  const model = optStr(v.ai_model);
  if (client) author.aiClient = client;
  if (model) author.aiModel = model;
  return author;
}

export function parseComment(v: unknown): ThreadComment | undefined {
  if (!isRecord(v) || !str(v.id) || !ID.test(v.id) || !str(v.thread_id) || !str(v.body) || !str(v.created_at)) return undefined;
  const author = parseAuthor(v.author);
  if (!author) return undefined;
  const comment: ThreadComment = {
    id: v.id,
    threadId: v.thread_id,
    author,
    mine: v.mine === true,
    body: v.body,
    createdAt: v.created_at,
  };
  if (isRecord(v.suggestion) && str(v.suggestion.text) && str(v.suggestion.base_sha)) {
    comment.suggestion = { text: v.suggestion.text, baseSha: v.suggestion.base_sha };
  }
  const edited = optStr(v.edited_at);
  if (edited) comment.editedAt = edited;
  return comment;
}

export function parseThread(v: unknown): CommentThread | undefined {
  if (!isRecord(v) || !str(v.id) || !ID.test(v.id)) return undefined;
  if (v.status !== 'open' && v.status !== 'resolved') return undefined;
  if (v.origin !== 'source' && v.origin !== 'preview') return undefined;
  if (typeof v.repo_id !== 'number' || !str(v.repo_full_name) || !str(v.created_by) || !str(v.created_at) || !str(v.updated_at))
    return undefined;
  const a = v.anchor;
  const p = v.position;
  if (!isRecord(a) || !isRecord(p) || !str(a.path) || !str(a.commit_sha) || !isRecord(a.quote)) return undefined;
  const q = a.quote;
  if (!str(q.exact) || !str(q.prefix) || !str(q.suffix)) return undefined;
  const anchorRange = parseRange(a);
  const positionRange = parseRange(p);
  if (!anchorRange || !positionRange || !str(p.commit_sha) || !str(p.state)) return undefined;
  const comments = Array.isArray(v.comments) ? v.comments.map(parseComment).filter((c): c is ThreadComment => c !== undefined) : [];
  const thread: CommentThread = {
    id: v.id,
    repoId: v.repo_id,
    repoFullName: v.repo_full_name,
    status: v.status,
    origin: v.origin,
    anchor: { path: a.path, commitSha: a.commit_sha, ...anchorRange, quote: { exact: q.exact, prefix: q.prefix, suffix: q.suffix } },
    position: { commitSha: p.commit_sha, ...positionRange, state: p.state },
    createdBy: v.created_by,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    comments,
  };
  const resolvedBy = optStr(v.resolved_by);
  const resolvedAt = optStr(v.resolved_at);
  if (resolvedBy) thread.resolvedBy = resolvedBy;
  if (resolvedAt) thread.resolvedAt = resolvedAt;
  return thread;
}

async function toError(res: Response): Promise<GatewayError> {
  const body = (await res.json().catch(() => ({}))) as unknown;
  const detail = `galley comments ${res.status}`;
  switch (res.status) {
    case 401:
      return new AuthRequiredError('sign in required');
    case 403:
      return new PermissionError(detail);
    case 404:
      return new NotFoundError(detail);
    case 409:
      return new ThreadStatusError(detail);
    case 413:
      return new CommentTooLargeError(detail);
    case 422:
      return new InvalidCommentError(detail, isRecord(body) && str(body.field) ? body.field.slice(0, 64) : undefined);
    case 429: {
      const after = Number(res.headers.get('Retry-After'));
      return new RateLimitedError(detail, Number.isFinite(after) && after > 0 ? Math.min(after, 3600) : 2);
    }
  }
  return res.status >= 500 ? new TransientError(detail) : new GatewayError(detail);
}

function commentBody(c: CommentInput): Json {
  return c.suggestion === undefined ? { body: c.body } : { body: c.body, suggestion: c.suggestion };
}

function threadBody(t: NewThread): Json {
  const body: Json = {
    path: t.path,
    commit_sha: t.commitSha,
    start_line: t.startLine,
    end_line: t.endLine,
  };
  if (t.startColumn !== undefined && t.endColumn !== undefined) {
    body.start_column = t.startColumn;
    body.end_column = t.endColumn;
  }
  body.quote = { exact: t.quote.exact, prefix: t.quote.prefix, suffix: t.quote.suffix };
  body.origin = t.origin;
  body.body = t.body;
  if (t.suggestion !== undefined) body.suggestion = t.suggestion;
  return body;
}

export function createHttpCommentsGateway(options: HttpCommentsOptions = {}): CommentsGateway {
  const base = `${(options.apiBase ?? apiBaseFromEnv()).replace(/\/+$/, '')}/api/galley`;
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  const send = async (method: string, path: string, body?: Json): Promise<unknown> => {
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

  const thread = (v: unknown): CommentThread => {
    const t = parseThread(v);
    if (!t) throw new GatewayError('malformed thread');
    return t;
  };
  const comment = (v: unknown): ThreadComment => {
    const c = parseComment(v);
    if (!c) throw new GatewayError('malformed comment');
    return c;
  };

  return {
    async listThreads(repoId, filter = {}) {
      const query = new URLSearchParams();
      if (filter.path) query.set('path', filter.path);
      if (filter.status) query.set('status', filter.status);
      if (filter.at && SHA.test(filter.at)) query.set('at', filter.at);
      const qs = query.toString();
      const data = await send('GET', `/repos/${checkRepo(repoId)}/threads${qs ? `?${qs}` : ''}`);
      if (!isRecord(data) || !Array.isArray(data.threads)) throw new GatewayError('malformed thread list');
      const list: ThreadList = {
        threads: data.threads.map(parseThread).filter((t): t is CommentThread => t !== undefined),
        truncated: data.truncated === true,
      };
      return list;
    },
    async createThread(repoId, t) {
      return thread(await send('POST', `/repos/${checkRepo(repoId)}/threads`, threadBody(t)));
    },
    async getThread(id) {
      return thread(await send('GET', `/threads/${checkId(id)}`));
    },
    async reply(threadId, c) {
      return comment(await send('POST', `/threads/${checkId(threadId)}/comments`, commentBody(c)));
    },
    async editComment(id, c) {
      return comment(await send('PATCH', `/comments/${checkId(id)}`, commentBody(c)));
    },
    async deleteComment(id) {
      await send('DELETE', `/comments/${checkId(id)}`);
    },
    async resolve(id) {
      return thread(await send('POST', `/threads/${checkId(id)}/resolve`));
    },
    async reopen(id) {
      return thread(await send('POST', `/threads/${checkId(id)}/reopen`));
    },
    async markRead(id) {
      await send('POST', `/threads/${checkId(id)}/read`);
    },
    async unread(repoId) {
      const data = await send('GET', `/repos/${checkRepo(repoId)}/unread`);
      if (!isRecord(data)) throw new GatewayError('malformed unread counts');
      const byThread: Record<string, number> = {};
      if (isRecord(data.by_thread)) {
        for (const [k, n] of Object.entries(data.by_thread)) {
          if (ID.test(k) && typeof n === 'number' && Number.isSafeInteger(n) && n > 0) byThread[k] = n;
        }
      }
      const counts: UnreadCounts = {
        threads: typeof data.threads === 'number' ? data.threads : 0,
        comments: typeof data.comments === 'number' ? data.comments : 0,
        byThread,
      };
      return counts;
    },
  };
}

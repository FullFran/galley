import { GatewayError, TransientError } from './errors';

// Line-anchored comment threads kept by the galley backend (not GitHub).
// Every text field below (bodies, quotes, suggestions, logins, paths) was
// written by someone else and is untrusted: render it as plain text only.

export type ThreadStatus = 'open' | 'resolved';
export type ThreadOrigin = 'source' | 'preview';

/** W3C TextQuoteSelector: the quoted text and a little context on each side. */
export interface Quote {
  exact: string;
  prefix: string;
  suffix: string;
}

/** 1-based inclusive line range; columns are 1-based (end inclusive) and absent for whole lines. */
export interface LineRange {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface ThreadAnchor extends LineRange {
  path: string;
  commitSha: string;
  quote: Quote;
}

export interface ThreadPosition extends LineRange {
  commitSha: string;
  /** exact | moved | fuzzy | orphaned (the server decides). */
  state: string;
}

export interface CommentAuthor {
  kind: 'human' | 'ai';
  login: string;
  aiClient?: string;
  aiModel?: string;
}

export interface ThreadComment {
  id: string;
  threadId: string;
  author: CommentAuthor;
  /** Written by the signed-in user: they may edit or delete it. */
  mine: boolean;
  body: string;
  /** Replacement text for the thread's anchored range. */
  suggestion?: { text: string; baseSha: string };
  createdAt: string;
  editedAt?: string;
}

export interface CommentThread {
  id: string;
  repoId: number;
  repoFullName: string;
  status: ThreadStatus;
  origin: ThreadOrigin;
  anchor: ThreadAnchor;
  position: ThreadPosition;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
  comments: ThreadComment[];
}

export interface ThreadList {
  threads: CommentThread[];
  /** More than the server's page (200) matched. */
  truncated: boolean;
}

export interface ThreadFilter {
  path?: string;
  status?: ThreadStatus;
  /** The head commit being viewed. */
  at?: string;
}

export interface NewThread extends ThreadAnchor {
  origin: ThreadOrigin;
  body: string;
  suggestion?: string;
}

export interface CommentInput {
  body: string;
  /** Omit to have no suggestion (an edit without it removes one). */
  suggestion?: string;
}

/** Comments by others the user has not read yet. */
export interface UnreadCounts {
  threads: number;
  comments: number;
  byThread: Record<string, number>;
}

/** Port for galley's comment API (web UI today; CLI and MCP later). */
export interface CommentsGateway {
  listThreads(repoId: number, filter?: ThreadFilter): Promise<ThreadList>;
  createThread(repoId: number, thread: NewThread): Promise<CommentThread>;
  getThread(id: string): Promise<CommentThread>;
  reply(threadId: string, comment: CommentInput): Promise<ThreadComment>;
  editComment(id: string, comment: CommentInput): Promise<ThreadComment>;
  deleteComment(id: string): Promise<void>;
  /** Needs push (write) access. */
  resolve(id: string): Promise<CommentThread>;
  /** Needs push (write) access. */
  reopen(id: string): Promise<CommentThread>;
  markRead(id: string): Promise<void>;
  unread(repoId: number): Promise<UnreadCounts>;
}

/** 413: the request was larger than the server accepts. */
export class CommentTooLargeError extends GatewayError {}

/** 422: the server refused a field (named by `field`, when it said which). */
export class InvalidCommentError extends GatewayError {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.field = field;
  }
}

/** 409: the thread already has that status. */
export class ThreadStatusError extends GatewayError {}

/** 429: too many writes; try again after `retryAfterSeconds`. */
export class RateLimitedError extends TransientError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

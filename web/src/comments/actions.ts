import type { CommentThread, ThreadComment } from '../domain/comments';
import { locateAnchor } from './suggestion';

// Small decisions of the comments UI, kept apart from the components so they
// can be tested without a DOM.

/** What the signed-in user may do with a thread and its comments. */
export function threadPermissions(thread: CommentThread, canPush: boolean) {
  return {
    resolve: canPush && thread.status === 'open',
    reopen: canPush && thread.status === 'resolved',
    reply: true,
    edit: (c: ThreadComment) => c.mine,
    remove: (c: ThreadComment) => c.mine,
  };
}

export interface ApplyDeps {
  /** The user's current buffer of the thread's file. */
  text: string;
  /** Replaces from..to in the buffer as an ordinary, undoable edit. Never commits. */
  edit: (from: number, to: number, insert: string) => void;
  /** Resolves the thread; only called with push access. */
  resolve: (threadId: string) => Promise<unknown>;
  canPush: boolean;
}

export type ApplyOutcome = 'applied' | 'applied-resolved' | 'failed';

/**
 * Puts a suggestion into the user's buffer. The thread is resolved only when
 * the user may resolve it; a failed resolve leaves the edit in place.
 */
export async function applyThreadSuggestion(thread: CommentThread, comment: ThreadComment, deps: ApplyDeps): Promise<ApplyOutcome> {
  if (!comment.suggestion) return 'failed';
  const at = locateAnchor(deps.text, { ...thread.position, quote: thread.anchor.quote });
  if (!at) return 'failed';
  deps.edit(at.from, at.to, comment.suggestion.text);
  if (!deps.canPush || thread.status !== 'open') return 'applied';
  try {
    await deps.resolve(thread.id);
    return 'applied-resolved';
  } catch {
    return 'applied';
  }
}

/** Threads for the panel: this file or the whole paper, open first, then by place. */
export function visibleThreads(
  threads: readonly CommentThread[],
  options: { scope: 'file' | 'paper'; path?: string; showResolved: boolean },
): CommentThread[] {
  return threads
    .filter((t) => (options.scope === 'paper' || t.anchor.path === options.path) && (options.showResolved || t.status === 'open'))
    .sort(
      (a, b) =>
        a.anchor.path.localeCompare(b.anchor.path) || a.position.startLine - b.position.startLine || a.createdAt.localeCompare(b.createdAt),
    );
}

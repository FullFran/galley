import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AuthRequiredError, NotFoundError, PermissionError, TransientError, type RepoAccess, type Repository } from '../domain';
import {
  CommentTooLargeError,
  InvalidCommentError,
  RateLimitedError,
  ThreadStatusError,
  type CommentThread,
  type CommentsGateway,
  type ThreadComment,
  type UnreadCounts,
} from '../domain/comments';
import { buildAnchor, type AnchorResult } from '../comments/anchor';
import { applyThreadSuggestion, visibleThreads } from '../comments/actions';
import { mapPreviewSelection } from '../comments/previewMap';
import { takeCommentsPanelRequest } from '../comments/panelRequest';
import { useTRef, type Messages } from '../i18n';
import type { CommentHandlers, CommentMark } from '../ui/editorComments';
import type { PreviewTextSelection, SourceLine } from '../ui/PreviewFrame';
import { ThreadsPanel, type CommentDraft } from '../ui/comments/ThreadsPanel';
import { Icon } from '../ui/shell/icons';
import '../ui/comments/comments.css';

// Comments anywhere: the state behind the comments panel, the editor markers
// and actions, and comments from the preview. Workspace only wires the
// pieces this returns into its layout.

export interface UseCommentsOptions {
  gateway?: CommentsGateway;
  repo: Repository;
  /** The commit the workspace shows; new threads anchor to it. */
  headSha?: string;
  openPath?: string;
  /** The current text of a file (buffer, else the repository), or undefined when it cannot be edited here. */
  readText: (path: string) => Promise<string | undefined>;
  /** The open file's current text. */
  openText?: string;
  access: (repo: Repository) => Promise<RepoAccess>;
  /** Opens a file in the editor, at a line. */
  onOpenAt: (path: string, line?: number) => void;
  /** Shows the preview (phones show one pane at a time). */
  onShowPreview: () => void;
  onNotice: (text: string) => void;
  onAuthRequired: () => void;
}

const POLL_MS = 120_000;
const NO_UNREAD: UnreadCounts = { threads: 0, comments: 0, byThread: {} };

export function commentErrorMessage(err: unknown, t: Messages): string {
  const m = t.comments;
  if (err instanceof RateLimitedError) return m.rateLimited(err.retryAfterSeconds);
  if (err instanceof CommentTooLargeError) return m.tooLarge;
  if (err instanceof InvalidCommentError) return m.invalid;
  if (err instanceof ThreadStatusError) return m.conflict;
  if (err instanceof NotFoundError) return m.notFound;
  if (err instanceof PermissionError) return m.permission;
  if (err instanceof TransientError) return t.errors.network;
  return t.errors.generic;
}

function anchorProblem(result: AnchorResult, t: Messages): string | undefined {
  if (result.kind === 'empty') return t.comments.selectFirst;
  if (result.kind === 'too-long') return t.comments.tooLong;
  if (result.kind === 'unsupported') return t.comments.unsupported;
  return undefined;
}

export function useComments(o: UseCommentsOptions) {
  const tRef = useTRef();
  const { gateway, repo } = o;
  const opts = useRef(o);
  opts.current = o;
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [truncated, setTruncated] = useState(false);
  const [unread, setUnread] = useState<UnreadCounts>(NO_UNREAD);
  const [canPush, setCanPush] = useState(false);
  const [scope, setScope] = useState<'file' | 'paper'>('file');
  const [showResolved, setShowResolved] = useState(false);
  const [activeId, setActiveId] = useState<string>();
  const [draft, setDraft] = useState<CommentDraft>();
  const [busy, setBusy] = useState(false);
  const [previewSelection, setPreviewSelection] = useState<PreviewTextSelection>();
  const [reveal, setReveal] = useState<SourceLine & { seq: number }>();
  const [applyEdit, setApplyEdit] = useState<{ from: number; to: number; insert: string; seq: number }>();

  const fail = useCallback((err: unknown) => {
    if (err instanceof AuthRequiredError) opts.current.onAuthRequired();
    else opts.current.onNotice(commentErrorMessage(err, tRef.current));
  }, [tRef]);

  const headSha = o.headSha;
  const load = useCallback(async () => {
    if (!gateway) return;
    setState((s) => (s === 'ready' ? s : 'loading'));
    try {
      const [list, counts] = await Promise.all([gateway.listThreads(repo.id, { at: headSha }), gateway.unread(repo.id)]);
      setThreads(list.threads);
      setTruncated(list.truncated);
      setUnread(counts);
      setState('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) opts.current.onAuthRequired();
      setState('error');
    }
  }, [gateway, repo.id, headSha]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!gateway) return;
    if (takeCommentsPanelRequest()) setOpen(true);
    let alive = true;
    // Fail closed: resolve and reopen stay hidden until push is confirmed.
    opts.current.access(repo).then(
      (a) => alive && setCanPush(a.canPush),
      () => undefined,
    );
    const timer = setInterval(() => {
      gateway.unread(repo.id).then((u) => alive && setUnread(u), () => undefined);
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [gateway, repo]);

  const replaceThread = (next: CommentThread) => setThreads((list) => list.map((t) => (t.id === next.id ? next : t)));

  const markRead = (id: string) => {
    if (!gateway || !unread.byThread[id]) return;
    gateway.markRead(id).then(
      () =>
        setUnread((u) => {
          const n = u.byThread[id] ?? 0;
          const byThread = Object.fromEntries(Object.entries(u.byThread).filter(([k]) => k !== id));
          return { threads: Math.max(0, u.threads - 1), comments: Math.max(0, u.comments - n), byThread };
        }),
      () => undefined,
    );
  };

  const openThread = (thread: CommentThread) => {
    setOpen(true);
    setActiveId(thread.id);
    markRead(thread.id);
    opts.current.onOpenAt(thread.anchor.path, thread.position.startLine);
  };

  const startDraft = (path: string, text: string, from: number, to: number, origin: CommentDraft['origin'], blockFallback: boolean) => {
    const result = buildAnchor(text, from, to);
    const problem = anchorProblem(result, tRef.current);
    if (problem || result.kind !== 'ok') return opts.current.onNotice(problem ?? tRef.current.errors.generic);
    setDraft({ path, range: result.range, quote: result.quote, origin, blockFallback, body: '' });
    setOpen(true);
  };

  // "Show in preview" works without the comments API, so the editor actions are always there.
  const editorComments: CommentHandlers & { marks: CommentMark[] } = useMemo(() => {
    const path = o.openPath;
    const marks = threads
      .filter((t) => t.status === 'open' && t.anchor.path === path)
      .map((t) => ({ threadId: t.id, startLine: t.position.startLine, endLine: t.position.endLine, unread: (unread.byThread[t.id] ?? 0) > 0 }));
    return {
      marks,
      onComment: (doc, from, to) => {
        const p = opts.current.openPath;
        if (!opts.current.gateway) opts.current.onNotice(tRef.current.comments.unavailable);
        else if (p) startDraft(p, doc, from, to, 'source', false);
      },
      onOpenThread: (id) => {
        const th = threadsRef.current.find((t) => t.id === id);
        if (!th) return;
        setOpen(true);
        setActiveId(id);
        markRead(id);
      },
      onShowInPreview: (line) => {
        const p = opts.current.openPath;
        if (!p) return;
        setReveal((r) => ({ path: p, line, seq: (r?.seq ?? 0) + 1 }));
        opts.current.onShowPreview();
      },
      labels: () => ({
        comment: tRef.current.comments.comment,
        showInPreview: tRef.current.comments.showInPreview,
        thread: tRef.current.comments.threadMarker,
      }),
    };
    // Handlers read the latest values through refs; marks follow the threads.
  }, [gateway, threads, unread, o.openPath]);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;

  const commentFromPreview = async () => {
    const sel = previewSelection;
    if (!sel) return;
    const path = sel.start.path;
    const text = await opts.current.readText(path);
    if (text === undefined) return opts.current.onNotice(tRef.current.comments.previewFile(path));
    const endLine = sel.end.path === path ? sel.end.line : sel.start.line;
    const hit = mapPreviewSelection(text, { startLine: sel.start.line, endLine, text: sel.text });
    if (!hit) return opts.current.onNotice(tRef.current.comments.selectFirst);
    opts.current.onOpenAt(path, sel.start.line);
    startDraft(path, text, hit.from, hit.to, 'preview', !hit.exact);
    setPreviewSelection(undefined);
  };

  const run = async (action: () => Promise<void>) => {
    if (!gateway || busy) return;
    setBusy(true);
    try {
      await action();
    } catch (err) {
      fail(err);
      if (err instanceof ThreadStatusError || err instanceof NotFoundError) void load();
    } finally {
      setBusy(false);
    }
  };

  const post = () =>
    run(async () => {
      const d = draft;
      const sha = opts.current.headSha;
      if (!gateway || !d || !sha || d.body.trim() === '') return;
      const created = await gateway.createThread(repo.id, {
        path: d.path,
        commitSha: sha,
        ...d.range,
        quote: d.quote,
        origin: d.origin,
        body: d.body,
        ...(d.suggestion !== undefined ? { suggestion: d.suggestion } : {}),
      });
      setThreads((list) => [...list.filter((t) => t.id !== created.id), created]);
      setDraft(undefined);
      setActiveId(created.id);
    });

  const updateComment = (threadId: string, change: (comments: ThreadComment[]) => ThreadComment[]) =>
    setThreads((list) =>
      list.flatMap((t) => {
        if (t.id !== threadId) return [t];
        const comments = change(t.comments);
        return comments.length ? [{ ...t, comments }] : [];
      }),
    );

  const shown = visibleThreads(threads, { scope, path: o.openPath, showResolved });
  const panel =
    gateway && open ? (
      <ThreadsPanel
        threads={shown}
        state={state}
        truncated={truncated}
        scope={scope}
        showResolved={showResolved}
        canPush={canPush}
        unread={unread.byThread}
        activeId={activeId}
        openPath={o.openPath}
        busy={busy}
        draft={draft}
        onScope={setScope}
        onShowResolved={setShowResolved}
        onOpen={openThread}
        onReply={(id, body) =>
          void run(async () => {
            const c = await gateway.reply(id, { body });
            updateComment(id, (list) => [...list, c]);
          })
        }
        onEdit={(comment, body) =>
          void run(async () => {
            // Keep the suggestion: an edit without one removes it.
            const c = await gateway.editComment(comment.id, { body, ...(comment.suggestion ? { suggestion: comment.suggestion.text } : {}) });
            updateComment(comment.threadId, (list) => list.map((x) => (x.id === c.id ? c : x)));
          })
        }
        onDelete={(comment) =>
          void run(async () => {
            await gateway.deleteComment(comment.id);
            updateComment(comment.threadId, (list) => list.filter((x) => x.id !== comment.id));
          })
        }
        onResolve={(th) => void run(async () => replaceThread(await gateway.resolve(th.id)))}
        onReopen={(th) => void run(async () => replaceThread(await gateway.reopen(th.id)))}
        onApply={(th, comment) =>
          void run(async () => {
            const text = opts.current.openText;
            if (text === undefined || th.anchor.path !== opts.current.openPath) return;
            const outcome = await applyThreadSuggestion(th, comment, {
              text,
              canPush,
              edit: (from, to, insert) => setApplyEdit((e) => ({ from, to, insert, seq: (e?.seq ?? 0) + 1 })),
              resolve: async (id) => replaceThread(await gateway.resolve(id)),
            });
            const m = tRef.current.comments;
            opts.current.onNotice(outcome === 'failed' ? m.applyFailed : outcome === 'applied' ? m.applied : m.appliedResolved);
          })
        }
        onDraft={(change) => setDraft((d) => d && { ...d, ...change })}
        onPost={() => void post()}
        onCancelDraft={() => setDraft(undefined)}
        onClose={() => setOpen(false)}
        onRetry={() => void load()}
      />
    ) : undefined;

  const t = tRef.current;
  const toggle = gateway ? (
    <button
      type="button"
      class="icon-button comments-toggle"
      aria-pressed={open}
      aria-label={unread.comments > 0 ? t.comments.unreadNav(unread.comments) : t.comments.toggle}
      data-tooltip={t.comments.toggle}
      data-tour="comments"
      onClick={() => setOpen((v) => !v)}
    >
      <Icon name="comment" />
      {unread.comments > 0 && (
        <span class="comments-toggle-badge" aria-hidden="true">
          {unread.comments}
        </span>
      )}
    </button>
  ) : undefined;

  const previewAction =
    gateway && previewSelection ? (
      <button type="button" class="preview-comment-button primary" onClick={() => void commentFromPreview()}>
        <Icon name="comment" /> {t.comments.commentOnSelection}
      </button>
    ) : undefined;

  return {
    enabled: gateway !== undefined,
    open,
    toggle: () => setOpen((v) => !v),
    toggleButton: toggle,
    panel,
    unread: unread.comments,
    editorComments,
    applyEdit,
    preview: {
      onSelection: gateway ? setPreviewSelection : undefined,
      onJump: (target: SourceLine) => opts.current.onOpenAt(target.path, target.line),
      reveal,
    },
    previewAction,
  };
}

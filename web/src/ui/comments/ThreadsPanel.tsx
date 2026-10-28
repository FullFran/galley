import { useEffect, useRef, useState } from 'preact/hooks';
import type { CommentThread, LineRange, Quote, ThreadComment, ThreadOrigin } from '../../domain/comments';
import { threadPermissions } from '../../comments/actions';
import { useT } from '../../i18n';
import { formatDateTime } from '../../i18n/format';
import { Icon } from '../shell/icons';

// The comments panel. Every text here (bodies, quotes, suggestions, logins,
// paths) was written by other people: it is rendered as text nodes only.

/** A new thread being written. */
export interface CommentDraft {
  path: string;
  range: LineRange;
  quote: Quote;
  origin: ThreadOrigin;
  /** The preview text was not found exactly; the anchor is the whole block. */
  blockFallback: boolean;
  body: string;
  /** Replacement text for the range; undefined when there is none. */
  suggestion?: string;
}

export interface ThreadsPanelProps {
  threads: CommentThread[];
  state: 'loading' | 'ready' | 'error';
  truncated: boolean;
  scope: 'file' | 'paper';
  showResolved: boolean;
  canPush: boolean;
  unread: Record<string, number>;
  /** The thread opened from a marker; it is scrolled into view. */
  activeId?: string;
  /** The file open in the editor (Apply works on it). */
  openPath?: string;
  busy: boolean;
  draft?: CommentDraft;
  onScope: (scope: 'file' | 'paper') => void;
  onShowResolved: (show: boolean) => void;
  onOpen: (thread: CommentThread) => void;
  onReply: (threadId: string, body: string) => void;
  onEdit: (comment: ThreadComment, body: string) => void;
  onDelete: (comment: ThreadComment) => void;
  onResolve: (thread: CommentThread) => void;
  onReopen: (thread: CommentThread) => void;
  onApply: (thread: CommentThread, comment: ThreadComment) => void;
  onDraft: (change: Partial<CommentDraft>) => void;
  onPost: () => void;
  onCancelDraft: () => void;
  onClose: () => void;
  onRetry: () => void;
}

export function ThreadsPanel(props: ThreadsPanelProps) {
  const t = useT();
  const m = t.comments;
  const { threads, state, scope, showResolved, draft } = props;
  return (
    <aside class="comments-panel" aria-label={m.title} data-tour="comments-panel">
      <header class="comments-head">
        <h2>{m.title}</h2>
        <button type="button" class="icon-button" aria-label={m.close} data-tooltip={m.close} onClick={props.onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div class="comments-filters">
        <div class="segmented" role="group" aria-label={m.title}>
          <button type="button" aria-pressed={scope === 'file'} onClick={() => props.onScope('file')}>
            {m.thisFile}
          </button>
          <button type="button" aria-pressed={scope === 'paper'} onClick={() => props.onScope('paper')}>
            {m.wholePaper}
          </button>
        </div>
        <label class="comments-resolved">
          <input type="checkbox" checked={showResolved} onChange={(e) => props.onShowResolved((e.target as HTMLInputElement).checked)} />
          {m.showResolved}
        </label>
      </div>
      {draft && <Composer {...props} draft={draft} />}
      <div class="comments-list">
        {state === 'loading' && <p class="muted">{m.loading}</p>}
        {state === 'error' && (
          <div class="notice notice-danger" role="alert">
            <p>{m.unavailable}</p>
            <button type="button" onClick={props.onRetry}>
              {m.tryAgain}
            </button>
          </div>
        )}
        {state === 'ready' && threads.length === 0 && !draft && <p class="muted">{m.none}</p>}
        {props.truncated && <p class="muted">{m.truncated}</p>}
        {state === 'ready' && threads.map((th) => <ThreadCard key={th.id} {...props} thread={th} />)}
      </div>
    </aside>
  );
}

function Composer(props: ThreadsPanelProps & { draft: CommentDraft }) {
  const m = useT().comments;
  const { draft, busy } = props;
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), [draft.path, draft.range.startLine, draft.quote.exact]);
  const where = `${draft.path}, ${m.lines(draft.range.startLine, draft.range.endLine)}`;
  return (
    <form
      class="comment-composer"
      aria-label={m.newThread}
      onSubmit={(e) => {
        e.preventDefault();
        props.onPost();
      }}
    >
      <p class="muted comment-where">{m.on(where)}</p>
      <blockquote class="comment-quote">{draft.quote.exact}</blockquote>
      {draft.blockFallback && <p class="muted comment-note">{m.blockFallback}</p>}
      <textarea
        ref={area}
        rows={3}
        aria-label={m.newThread}
        placeholder={m.placeholder}
        value={draft.body}
        onInput={(e) => props.onDraft({ body: (e.target as HTMLTextAreaElement).value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            props.onPost();
          }
          if (e.key === 'Escape') props.onCancelDraft();
        }}
      />
      {draft.suggestion !== undefined && (
        <label class="comment-suggestion-input">
          {m.suggestionLabel}
          <textarea rows={3} value={draft.suggestion} onInput={(e) => props.onDraft({ suggestion: (e.target as HTMLTextAreaElement).value })} />
        </label>
      )}
      <div class="actions">
        <button
          type="button"
          onClick={() => props.onDraft({ suggestion: draft.suggestion === undefined ? draft.quote.exact : undefined })}
        >
          {draft.suggestion === undefined ? m.addSuggestion : m.removeSuggestion}
        </button>
        <button type="submit" class="primary" disabled={busy || draft.body.trim() === ''}>
          {m.post}
        </button>
        <button type="button" onClick={props.onCancelDraft}>
          {m.cancel}
        </button>
      </div>
    </form>
  );
}

function author(c: ThreadComment, t: ReturnType<typeof useT>) {
  return c.author.kind === 'ai' ? t.comments.ai(c.author.aiClient ?? '?', c.author.aiModel ?? '', c.author.login) : c.author.login;
}

function ThreadCard(props: ThreadsPanelProps & { thread: CommentThread }) {
  const t = useT();
  const m = t.comments;
  const { thread, canPush, busy, unread, activeId, scope } = props;
  const can = threadPermissions(thread, canPush);
  const [reply, setReply] = useState('');
  const card = useRef<HTMLElement>(null);
  const active = activeId === thread.id;
  useEffect(() => {
    if (active) card.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const count = unread[thread.id] ?? 0;
  const where = m.lines(thread.position.startLine, thread.position.endLine);
  return (
    <article
      ref={card}
      class={`thread-card${active ? ' thread-card-active' : ''}${thread.status === 'resolved' ? ' thread-card-resolved' : ''}`}
      data-thread-id={thread.id}
    >
      <button type="button" class="thread-anchor" onClick={() => props.onOpen(thread)}>
        <span class="muted">
          {scope === 'paper' ? `${thread.anchor.path}, ${where}` : where}
          {thread.origin === 'preview' ? ` · ${m.fromPreview}` : ''}
        </span>
        {count > 0 && <span class="badge">{m.unread(count)}</span>}
        {thread.status === 'resolved' && <span class="badge badge-muted">{m.resolved}</span>}
        <blockquote class="comment-quote">{thread.anchor.quote.exact}</blockquote>
      </button>
      {thread.comments.map((c) => (
        <CommentItem key={c.id} {...props} comment={c} canEdit={can.edit(c)} />
      ))}
      <div class="thread-reply">
        <textarea rows={2} aria-label={m.reply} placeholder={m.replyPlaceholder} value={reply} onInput={(e) => setReply((e.target as HTMLTextAreaElement).value)} />
        <div class="actions">
          <button
            type="button"
            disabled={busy || reply.trim() === ''}
            onClick={() => {
              props.onReply(thread.id, reply);
              setReply('');
            }}
          >
            {m.reply}
          </button>
          {can.resolve && (
            <button type="button" disabled={busy} onClick={() => props.onResolve(thread)}>
              {m.resolve}
            </button>
          )}
          {can.reopen && (
            <button type="button" disabled={busy} onClick={() => props.onReopen(thread)}>
              {m.reopen}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function CommentItem(props: ThreadsPanelProps & { thread: CommentThread; comment: ThreadComment; canEdit: boolean }) {
  const t = useT();
  const m = t.comments;
  const { comment, thread, busy, canEdit } = props;
  const [editing, setEditing] = useState<string>();
  return (
    <div class={comment.author.kind === 'ai' ? 'thread-comment thread-comment-ai' : 'thread-comment'}>
      <p class="muted thread-comment-meta">
        <strong>{author(comment, t)}</strong> {formatDateTime(comment.createdAt, t.meta.lang)}
        {comment.editedAt ? ` · ${m.edited}` : ''}
      </p>
      {editing === undefined ? (
        <p class="comment-body">{comment.body}</p>
      ) : (
        <div class="thread-edit">
          <textarea rows={3} aria-label={m.edit} value={editing} onInput={(e) => setEditing((e.target as HTMLTextAreaElement).value)} />
          <div class="actions">
            <button
              type="button"
              class="primary"
              disabled={busy || editing.trim() === ''}
              onClick={() => {
                props.onEdit(comment, editing);
                setEditing(undefined);
              }}
            >
              {m.save}
            </button>
            <button type="button" onClick={() => setEditing(undefined)}>
              {m.cancel}
            </button>
          </div>
        </div>
      )}
      {comment.suggestion && (
        <div class="suggestion">
          <span class="muted">{m.suggested}</span>
          <pre class="suggestion-diff">
            <del>{thread.anchor.quote.exact}</del>
            <ins>{comment.suggestion.text}</ins>
          </pre>
          {thread.anchor.path === props.openPath ? (
            <button type="button" disabled={busy} title={m.applyHint} onClick={() => props.onApply(thread, comment)}>
              {m.apply}
            </button>
          ) : (
            <button type="button" onClick={() => props.onOpen(thread)}>
              {m.openFile}
            </button>
          )}
        </div>
      )}
      {canEdit && editing === undefined && (
        <div class="actions thread-own">
          <button type="button" class="link-button" disabled={busy} onClick={() => setEditing(comment.body)}>
            {m.edit}
          </button>
          <button type="button" class="link-button" disabled={busy} onClick={() => props.onDelete(comment)}>
            {m.delete}
          </button>
        </div>
      )}
    </div>
  );
}

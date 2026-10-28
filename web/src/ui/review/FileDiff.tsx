import type { ChangedFile, DiffSide, NewComment, ReviewComment } from '../../domain';
import { anchorOf, parsePatch, type DiffLine } from '../../review/diff';
import { parseSuggestion, withoutSuggestion } from '../../review/suggestion';
import { placeThreads, type Thread } from '../../review/threads';
import { useT, type Messages } from '../../i18n';
import { formatDate, GitHubLink } from './GitHubLink';

/** A line comment being written. `startLine` is kept as typed until it is sent. */
export interface CommentDraft {
  /** The proposal head the line numbers refer to. */
  headSha: string;
  path: string;
  side: DiffSide;
  line: number;
  startLine: string;
  text: string;
}

export interface FileDiffProps {
  file: ChangedFile;
  threads: Thread[];
  /** Comments added to the review but not sent yet. */
  pending?: NewComment[];
  composer?: CommentDraft;
  replyDrafts: Record<number, string>;
  /** Whether suggestions in this proposal can be applied by the user. */
  canApply: boolean;
  busy: boolean;
  onStartComment: (path: string, side: DiffSide, line: number) => void;
  onComposer: (change: Partial<CommentDraft>) => void;
  onSendComment: () => void;
  onQueueComment: () => void;
  onCancelComment: () => void;
  onSuggest: () => void;
  onReplyDraft: (rootId: number, text: string) => void;
  onReply: (rootId: number) => void;
  onApply: (comment: ReviewComment) => void;
}

const STATUS: Record<string, string> = {
  added: 'new file',
  removed: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
};

export function FileDiff(props: FileDiffProps) {
  const { file, threads, pending = [], composer } = props;
  const lines = file.patch === undefined ? undefined : parsePatch(file.patch);
  const placed = placeThreads(lines ?? [], file.path, threads);

  return (
    <section class="file-diff">
      <header class="file-diff-head">
        <strong>{file.path}</strong>
        {file.previousPath && <span class="muted"> (was {file.previousPath})</span>}
        <span class="muted">
          {' '}
          {STATUS[file.status] ?? ''} +{file.additions} −{file.deletions}
        </span>
      </header>
      {placed.file.length > 0 && (
        <div class="outdated">
          <p class="muted">Comments on this file</p>
          {placed.file.map((t) => (
            <ThreadView key={t.root.id} thread={t} {...props} canApply={false} />
          ))}
        </div>
      )}
      {lines === undefined ? (
        <p class="muted diff-missing">
          No line-by-line view for this file (it is not text, or the change is too large). Open the proposal on GitHub
          to see it.
        </p>
      ) : (
        <div class="diff" role="table" aria-label={`Changes in ${file.path}`}>
          {lines.map((line, i) => {
            const anchor = anchorOf(line);
            const here = anchor && composer?.path === file.path && composer.side === anchor.side && composer.line === anchor.line;
            const queued = anchor ? pending.filter((c) => c.side === anchor.side && c.line === anchor.line) : [];
            return (
              <div key={i}>
                <DiffRow line={line} onComment={anchor && (() => props.onStartComment(file.path, anchor.side, anchor.line))} />
                {placed.byLine.get(i)?.map((t) => <ThreadView key={t.root.id} thread={t} {...props} />)}
                {queued.map((c, j) => (
                  <div key={j} class="comment comment-pending">
                    <span class="muted">Pending, sent with your review:</span>
                    <p class="comment-body">{c.body}</p>
                  </div>
                ))}
                {here && composer && <Composer draft={composer} {...props} />}
              </div>
            );
          })}
        </div>
      )}
      {placed.earlier.length > 0 && (
        <div class="outdated">
          <p class="muted">Comments on an earlier version of this file</p>
          {placed.earlier.map((t) => (
            <ThreadView key={t.root.id} thread={t} {...props} canApply={false} />
          ))}
        </div>
      )}
    </section>
  );
}

/** "Lines 5–9" for a hunk header such as `@@ -5,4 +5,5 @@`, instead of the raw header. */
export function hunkLabel(text: string, t: Messages): string {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
  if (!m) return '';
  const from = Number(m[1]);
  const count = m[2] === undefined ? 1 : Number(m[2]);
  return count === 0 ? '' : t.review.lines(from, from + count - 1);
}

function DiffRow({ line, onComment }: { line: DiffLine; onComment?: () => void }) {
  const t = useT();
  if (line.kind === 'hunk' || line.kind === 'meta') {
    return (
      <div class="diff-row diff-hunk" role="row">
        <span class="diff-gap">{line.kind === 'hunk' ? hunkLabel(line.text, t) : line.text}</span>
      </div>
    );
  }
  const oldNo = line.kind === 'add' ? '' : line.oldLine;
  const newNo = line.kind === 'del' ? '' : line.newLine;
  const label = line.kind === 'del' ? `Comment on removed line ${line.oldLine}` : `Comment on line ${line.newLine}`;
  const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
  return (
    <div class={`diff-row diff-${line.kind}`} role="row">
      <button type="button" class="diff-comment" aria-label={label} onClick={onComment}>
        +
      </button>
      <span class="diff-no">{oldNo}</span>
      <span class="diff-no">{newNo}</span>
      <code>
        {mark}
        {line.text}
      </code>
    </div>
  );
}

function ThreadView(props: FileDiffProps & { thread: Thread }) {
  const { thread, replyDrafts, busy } = props;
  const draft = replyDrafts[thread.root.id] ?? '';
  return (
    <div class="thread">
      {[thread.root, ...thread.replies].map((c) => (
        <CommentView key={c.id} comment={c} canApply={props.canApply} busy={busy} onApply={props.onApply} />
      ))}
      <div class="thread-reply">
        <textarea
          rows={2}
          aria-label="Reply"
          placeholder="Reply…"
          value={draft}
          onInput={(e) => props.onReplyDraft(thread.root.id, (e.target as HTMLTextAreaElement).value)}
        />
        <button type="button" disabled={busy || draft.trim() === ''} onClick={() => props.onReply(thread.root.id)}>
          Reply
        </button>
      </div>
    </div>
  );
}

function CommentView({
  comment,
  canApply,
  busy,
  onApply,
}: {
  comment: ReviewComment;
  canApply: boolean;
  busy: boolean;
  onApply: (comment: ReviewComment) => void;
}) {
  const suggestion = parseSuggestion(comment.body);
  const text = suggestion === undefined ? comment.body : withoutSuggestion(comment.body);
  return (
    <article class="comment">
      <header class="muted">
        <strong>{comment.author?.login ?? 'someone'}</strong> {formatDate(comment.createdAt)}
        {comment.startLine !== null && comment.line !== null && ` · lines ${comment.startLine}–${comment.line}`}{' '}
        <GitHubLink href={comment.htmlUrl} />
      </header>
      {text && <p class="comment-body">{text}</p>}
      {suggestion !== undefined && (
        <div class="suggestion">
          <span class="muted">Suggested change</span>
          <pre>{suggestion === '' ? '(remove these lines)' : suggestion}</pre>
          {canApply && comment.line !== null && comment.side === 'RIGHT' && (
            <button type="button" disabled={busy} onClick={() => onApply(comment)}>
              Apply suggestion
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function Composer(props: FileDiffProps & { draft: CommentDraft }) {
  const { draft, busy } = props;
  const empty = draft.text.trim() === '';
  return (
    <div class="composer">
      <label>
        From line (optional, for several lines)
        <input
          type="number"
          min={1}
          max={draft.line}
          value={draft.startLine}
          onInput={(e) => props.onComposer({ startLine: (e.target as HTMLInputElement).value })}
        />
      </label>
      <label>
        Comment on line {draft.line}
        <textarea rows={4} value={draft.text} onInput={(e) => props.onComposer({ text: (e.target as HTMLTextAreaElement).value })} />
      </label>
      <div class="actions">
        {draft.side === 'RIGHT' && (
          <button type="button" onClick={props.onSuggest}>
            Suggest a change
          </button>
        )}
        <button type="button" class="primary" disabled={busy || empty} onClick={props.onSendComment}>
          Comment now
        </button>
        <button type="button" disabled={busy || empty} onClick={props.onQueueComment}>
          Add to review
        </button>
        <button type="button" onClick={props.onCancelComment}>
          Cancel
        </button>
      </div>
    </div>
  );
}

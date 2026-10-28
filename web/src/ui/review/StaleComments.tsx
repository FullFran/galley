import type { NewComment } from '../../domain';

export interface StaleCommentsProps {
  comments: NewComment[];
  onDismiss: () => void;
}

/** Draft comments that were not sent because the proposal changed; their text stays copyable. */
export function StaleComments({ comments, onDismiss }: StaleCommentsProps) {
  if (comments.length === 0) return null;
  return (
    <section class="banner banner-warn" role="status">
      <p>
        The proposal changed after you wrote {comments.length === 1 ? 'this comment' : 'these comments'}, so the line
        numbers may no longer match and nothing was sent. Copy the text and add it again on the current lines.
      </p>
      {comments.map((c, i) => (
        <label key={i} class="unsaved-copy">
          {c.path}, line {c.line}
          <textarea readOnly rows={3} value={c.body} />
        </label>
      ))}
      <div class="actions">
        <button type="button" onClick={onDismiss}>
          Done
        </button>
      </div>
    </section>
  );
}

import type { NewComment } from '../../domain';
import { useT } from '../../i18n';

export interface StaleCommentsProps {
  comments: NewComment[];
  onDismiss: () => void;
}

/** Draft comments that were not sent because the proposal changed; their text stays copyable. */
export function StaleComments({ comments, onDismiss }: StaleCommentsProps) {
  const m = useT().stale;
  if (comments.length === 0) return null;
  return (
    <section class="banner banner-warn" role="status">
      <p>{m.intro(comments.length)}</p>
      {comments.map((c, i) => (
        <label key={i} class="unsaved-copy">
          {m.where(c.path, c.line)}
          <textarea readOnly rows={3} value={c.body} />
        </label>
      ))}
      <div class="actions">
        <button type="button" onClick={onDismiss}>
          {m.done}
        </button>
      </div>
    </section>
  );
}

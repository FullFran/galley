import type { ConfigProblem } from '../../config/schema';
import { useT } from '../../i18n';

export interface ViewNoticeProps {
  admin: boolean;
  state: 'missing' | 'valid' | 'invalid';
  repoName: string;
  /** Files co-authors see; shown to admins as a count. */
  visibleCount: number;
  problems: ConfigProblem[];
  onSettings: () => void;
}

/**
 * Explains which files galley lists and why. The restriction is galley's own
 * view chosen by the project admin; GitHub permissions do not change.
 */
export function ViewNotice({ admin, state, repoName, visibleCount, problems, onSettings }: ViewNoticeProps) {
  const m = useT().viewNotice;
  if (admin) {
    if (state === 'missing') {
      return (
        <div class="banner banner-warn" role="status">
          <p>{m.setupNeeded}</p>
          <button type="button" class="primary" onClick={onSettings}>
            {m.setupButton}
          </button>
        </div>
      );
    }
    if (state === 'invalid') {
      return (
        <div class="banner banner-error" role="alert">
          <p>{m.invalid}</p>
          <ProblemList problems={problems} />
          <button type="button" onClick={onSettings}>
            {m.openSettings}
          </button>
        </div>
      );
    }
    return (
      <div class="view-notice">
        <p class="muted">{m.adminView(repoName, visibleCount)}</p>
        {problems.length > 0 && <ProblemList problems={problems} />}
        <button type="button" onClick={onSettings}>
          {m.settings}
        </button>
      </div>
    );
  }
  if (state === 'valid') {
    return (
      <p class="muted view-notice">{m.coauthorView}</p>
    );
  }
  return (
    <p class="banner banner-warn view-notice" role="status">
      {state === 'missing' ? m.missing(repoName) : m.broken(repoName)} {m.fallback}
    </p>
  );
}

export function ProblemList({ problems }: { problems: ConfigProblem[] }) {
  const m = useT().viewNotice;
  return (
    <ul class="config-problems">
      {problems.map((p, i) => (
        <li key={i} class={`problem-${p.severity}`}>
          {p.severity === 'error' ? m.error : m.note}
          {p.message}
        </li>
      ))}
    </ul>
  );
}

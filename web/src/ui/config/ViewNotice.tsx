import type { ConfigProblem } from '../../config/schema';

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
  if (admin) {
    if (state === 'missing') {
      return (
        <div class="banner banner-warn" role="status">
          <p>This paper is not set up for galley yet. Choose which files co-authors edit and where figures go.</p>
          <button type="button" class="primary" onClick={onSettings}>
            Set up galley for this paper
          </button>
        </div>
      );
    }
    if (state === 'invalid') {
      return (
        <div class="banner banner-error" role="alert">
          <p>.galley.yml has problems, so co-authors see only the paper's text files until it is fixed:</p>
          <ProblemList problems={problems} />
          <button type="button" onClick={onSettings}>
            Open project settings
          </button>
        </div>
      );
    }
    return (
      <div class="view-notice">
        <p class="muted">
          You see all files because you are an admin of {repoName}. Co-authors see {visibleCount} file
          {visibleCount === 1 ? '' : 's'}.
        </p>
        {problems.length > 0 && <ProblemList problems={problems} />}
        <button type="button" onClick={onSettings}>
          Project settings
        </button>
      </div>
    );
  }
  if (state === 'valid') {
    return (
      <p class="muted view-notice">
        Showing the files the project admin chose for editing in galley. This is a galley view, not a GitHub permission.
      </p>
    );
  }
  return (
    <p class="banner banner-warn view-notice" role="status">
      {state === 'missing'
        ? `This paper is not set up for galley yet; ask an admin of ${repoName} to set it up.`
        : `The galley settings of this paper have problems; ask an admin of ${repoName} to fix them.`}{' '}
      Until then galley shows the paper's text files (.qmd, .md, .bib).
    </p>
  );
}

export function ProblemList({ problems }: { problems: ConfigProblem[] }) {
  return (
    <ul class="config-problems">
      {problems.map((p, i) => (
        <li key={i} class={`problem-${p.severity}`}>
          {p.severity === 'error' ? 'Error: ' : 'Note: '}
          {p.message}
        </li>
      ))}
    </ul>
  );
}

import type { ConfigProblem } from '../../config/schema';
import { useT } from '../../i18n';
import { Icon } from '../shell/icons';

export interface SetupBannerProps {
  admin: boolean;
  state: 'missing' | 'valid' | 'invalid';
  repoName: string;
  problems: ConfigProblem[];
  /** Dismissed for this repository in this browser. */
  dismissed: boolean;
  /** Not repeated on the settings screen it points to. */
  hidden?: boolean;
  onSettings: () => void;
  onDismiss: () => void;
}

/**
 * One line above the editor when the paper is not set up for galley, or its
 * settings are broken: galley then shows the text files only. Admins get the
 * action, co-authors a "Why?" with the full explanation. Dismissible per
 * repository. The restriction is galley's own view, not a GitHub permission.
 */
export function SetupBanner({ admin, state, repoName, problems, dismissed, hidden, onSettings, onDismiss }: SetupBannerProps) {
  const t = useT();
  if (state === 'valid' || dismissed || hidden) return null;
  const m = t.setup;
  const why = state === 'missing' ? t.viewNotice.missing(repoName) : t.viewNotice.broken(repoName);
  return (
    <div class={state === 'missing' ? 'line-banner line-banner-warn' : 'line-banner line-banner-error'} role="status">
      <p class="line-banner-text">{state === 'missing' ? m.missing : m.invalid}</p>
      {admin ? (
        <>
          {problems.length > 0 && (
            <details class="line-banner-why">
              <summary>{m.why}</summary>
              <div class="popover line-banner-pop">
                <ProblemList problems={problems} />
              </div>
            </details>
          )}
          <button type="button" class="line-banner-action" onClick={onSettings}>
            {state === 'missing' ? m.setUp : m.fix}
          </button>
        </>
      ) : (
        <details class="line-banner-why">
          <summary>{m.why}</summary>
          <p class="popover line-banner-pop">
            {why} {t.viewNotice.fallback}
          </p>
        </details>
      )}
      <button type="button" class="icon-button line-banner-close" aria-label={t.shell.dismiss} onClick={onDismiss}>
        <Icon name="close" />
      </button>
    </div>
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

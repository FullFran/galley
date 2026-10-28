import { useT } from '../i18n';
import { Icon } from './shell/icons';

export type UpstreamBannerState =
  | { kind: 'behind'; behind: number; branch: string; busy: boolean }
  | { kind: 'conflict'; url: string }
  /** Files where both sides changed the same lines; they need a choice before saving. */
  | { kind: 'choose'; files: string[] };

export interface UpstreamBannerProps {
  state: UpstreamBannerState;
  onBringIn: () => void;
  /** Opens the first file that needs a choice. */
  onReview?: () => void;
  onDismiss: () => void;
}

/**
 * A one-line, non-blocking prompt above the editor, like VS Code's "pull"
 * hint: the default branch has new changes, bring them in when you want.
 */
export function UpstreamBanner({ state, onBringIn, onReview, onDismiss }: UpstreamBannerProps) {
  const m = useT().upstream;
  const dismiss = (
    <button type="button" class="icon-button line-banner-close" aria-label={m.dismiss} title={m.dismiss} onClick={onDismiss}>
      <Icon name="close" />
    </button>
  );
  if (state.kind === 'conflict') {
    return (
      <div class="line-banner line-banner-warn" role="status">
        <Icon name="info" class="line-banner-icon" />
        <p class="line-banner-text line-banner-text-wrap">{m.conflict}</p>
        <a class="line-banner-action" href={state.url} target="_blank" rel="noopener noreferrer">
          {m.resolve}
        </a>
        {dismiss}
      </div>
    );
  }
  if (state.kind === 'choose') {
    // Stays until every place has a choice: saving is blocked until then.
    return (
      <div class="line-banner line-banner-warn" role="status">
        <Icon name="info" class="line-banner-icon" />
        <p class="line-banner-text line-banner-text-wrap">{m.choose(state.files.join(', '))}</p>
        <button type="button" class="line-banner-action" onClick={onReview}>
          {m.review}
        </button>
      </div>
    );
  }
  return (
    <div class="line-banner line-banner-info" role="status">
      <Icon name="proposals" class="line-banner-icon" />
      <p class="line-banner-text line-banner-text-wrap">{m.behind(state.behind, state.branch)}</p>
      <button type="button" class="line-banner-action" disabled={state.busy} onClick={onBringIn}>
        {state.busy ? m.bringingIn : m.bringIn}
      </button>
      {dismiss}
    </div>
  );
}

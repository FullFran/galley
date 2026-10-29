import type { FileChange } from '../domain';
import { useT } from '../i18n';

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; pullRequestUrl?: string }
  | { kind: 'conflict'; copies: FileChange[]; reloaded: boolean }
  | { kind: 'error'; message: string };

export interface StatusBannerProps {
  status: SaveStatus;
  onReload: () => void;
  onDismiss: () => void;
}

export function StatusBanner({ status, onReload, onDismiss }: StatusBannerProps) {
  const t = useT();
  const m = t.saveStatus;
  switch (status.kind) {
    case 'idle':
      return null;
    case 'saving':
      return <p class="banner" role="status">{t.save.saving}</p>;
    case 'saved':
      return status.pullRequestUrl ? (
        <p class="banner banner-ok" role="status">
          {m.saved}{' '}
          {status.pullRequestUrl.startsWith('#') ? (
            <a href={status.pullRequestUrl}>{m.viewProposalHere}</a>
          ) : (
            <a href={status.pullRequestUrl} target="_blank" rel="noopener noreferrer">
              {m.viewProposal}
            </a>
          )}
        </p>
      ) : (
        <p class="banner banner-warn" role="status">
          {m.savedNoProposal}
        </p>
      );
    case 'error':
      return (
        <p class="banner banner-error" role="alert">
          {status.message}
        </p>
      );
    case 'conflict':
      return (
        <section class="banner banner-error" role="alert">
          <p>
            {m.conflict} {status.reloaded ? m.conflictReloaded : m.conflictKept}
          </p>
          <UnsavedCopies copies={status.copies} />
          <div class="actions">
            {!status.reloaded && (
              <button type="button" class="primary" onClick={onReload}>
                {m.reload}
              </button>
            )}
            <button type="button" onClick={onDismiss}>
              {status.reloaded ? m.done : m.cancel}
            </button>
          </div>
        </section>
      );
  }
}

/** Read-only copies of the user's text so it can be copied elsewhere. */
export function UnsavedCopies({ copies }: { copies: FileChange[] }) {
  const m = useT().saveStatus;
  return (
    <>
      {copies.map((copy) => (
        <label key={copy.path} class="unsaved-copy">
          {m.yourText(copy.path)}
          <textarea readOnly rows={6} value={copy.content} />
        </label>
      ))}
    </>
  );
}

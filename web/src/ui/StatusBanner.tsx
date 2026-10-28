import type { FileChange } from '../domain';

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
  switch (status.kind) {
    case 'idle':
      return null;
    case 'saving':
      return <p class="banner" role="status">Saving…</p>;
    case 'saved':
      return status.pullRequestUrl ? (
        <p class="banner banner-ok" role="status">
          Saved. Changes are proposed for review.{' '}
          <a href={status.pullRequestUrl} target="_blank" rel="noopener noreferrer">
            View proposal on GitHub
          </a>
        </p>
      ) : (
        <p class="banner banner-warn" role="status">
          Saved; could not open the proposal, retry later.
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
            Someone else changed the document since you opened it, so your changes were not saved.{' '}
            {status.reloaded
              ? 'The latest version is now loaded. Copy your text below back into the editor where needed, then save.'
              : 'Your text is kept below. Reload to get the latest version, then copy your text back in.'}
          </p>
          <UnsavedCopies copies={status.copies} />
          <div class="actions">
            {!status.reloaded && (
              <button type="button" class="primary" onClick={onReload}>
                Reload
              </button>
            )}
            <button type="button" onClick={onDismiss}>
              {status.reloaded ? 'Done' : 'Cancel'}
            </button>
          </div>
        </section>
      );
  }
}

/** Read-only copies of the user's text so it can be copied elsewhere. */
export function UnsavedCopies({ copies }: { copies: FileChange[] }) {
  return (
    <>
      {copies.map((copy) => (
        <label key={copy.path} class="unsaved-copy">
          Your text of {copy.path}
          <textarea readOnly rows={6} value={copy.content} />
        </label>
      ))}
    </>
  );
}

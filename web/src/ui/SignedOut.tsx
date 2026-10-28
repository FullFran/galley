import type { FileChange } from '../domain';
import { UnsavedCopies } from './StatusBanner';

export interface SignedOutProps {
  loginFailed: boolean;
  notice?: string;
  /** Set when the page was opened over http: sign in only works over https. */
  httpsUrl?: string;
  /** Edits that could not be saved because the session ended. */
  unsaved?: FileChange[];
  onSignIn: () => void;
}

export function SignedOut({ loginFailed, notice, httpsUrl, unsaved = [], onSignIn }: SignedOutProps) {
  return (
    <main class="card">
      <h1>galley</h1>
      <p>Edit the files of your paper in the browser. Your changes are proposed for review on GitHub.</p>
      {loginFailed && (
        <p class="banner banner-error" role="alert">
          Sign in did not complete. Please try again.
        </p>
      )}
      {notice && (
        <p class="banner banner-error" role="alert">
          {notice}
        </p>
      )}
      {unsaved.length > 0 && (
        <section class="banner banner-warn">
          <p>These changes were not saved. Copy them before signing in again, because signing in reloads the page.</p>
          <UnsavedCopies copies={unsaved} />
        </section>
      )}
      {httpsUrl ? (
        <p class="banner banner-warn" role="alert">
          Open galley over https: <a href={httpsUrl}>{httpsUrl}</a>
        </p>
      ) : (
        <button type="button" class="primary" onClick={onSignIn}>
          Sign in with GitHub
        </button>
      )}
    </main>
  );
}

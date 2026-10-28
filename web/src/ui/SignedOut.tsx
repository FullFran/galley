import type { FileChange } from '../domain';
import { useT } from '../i18n';
import { Credit } from './shell/Credit';
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

/** Landing and sign in: what galley does, one action, what access it needs. */
export function SignedOut({ loginFailed, notice, httpsUrl, unsaved = [], onSignIn }: SignedOutProps) {
  const t = useT();
  const m = t.landing;
  return (
    <div class="landing">
      <main id="main" class="landing-main">
        <section class="landing-intro">
          <p class="brand">{t.app.name}</p>
          <h1>{m.title}</h1>
          <p class="lead">{m.lead}</p>
          {loginFailed && (
            <p class="notice notice-danger" role="alert">
              {m.loginFailed}
            </p>
          )}
          {notice && (
            <p class="notice notice-danger" role="alert">
              {notice}
            </p>
          )}
          {unsaved.length > 0 && (
            <section class="notice notice-warn">
              <p>{m.unsaved}</p>
              <UnsavedCopies copies={unsaved} />
            </section>
          )}
          {httpsUrl ? (
            <p class="notice notice-warn" role="alert">
              {m.https} <a href={httpsUrl}>{httpsUrl}</a>
            </p>
          ) : (
            <button type="button" class="primary large" onClick={onSignIn}>
              {m.signIn}
            </button>
          )}
          <p class="muted access-note">{m.access}</p>
        </section>
        <LandingMock saveLabel={m.mockSave} />
      </main>
      <footer class="landing-foot">
        <Credit />
      </footer>
    </div>
  );
}

/** A static drawing of the editor next to the preview; no real paper content. */
function LandingMock({ saveLabel }: { saveLabel: string }) {
  const bars = (widths: number[], cls = 'mock-line') => widths.map((w, i) => <span key={i} class={`${cls} w-${w}`} />);
  return (
    <div class="landing-mock" aria-hidden="true">
      <div class="mock-bar">
        <span class="mock-crumb" />
        <span class="mock-button">{saveLabel}</span>
      </div>
      <div class="mock-panes">
        <div class="mock-editor">
          <span class="mock-code mock-heading"># Introduction</span>
          {bars([90, 75, 85, 40], 'mock-code-line')}
          <span class="mock-code mock-heading">## Model</span>
          {bars([80, 95, 60], 'mock-code-line')}
          <span class="mock-code">{'$$ p = s e^{-E/kT} $$'}</span>
          {bars([70, 50], 'mock-code-line')}
        </div>
        <div class="mock-preview">
          <div class="mock-sheet">
            <span class="mock-title" />
            <span class="mock-authors" />
            <span class="mock-rule" />
            {bars([100, 100, 70])}
            <span class="mock-section">1. Introduction</span>
            {bars([100, 100, 100, 55])}
            <span class="mock-figure" />
            <span class="mock-eq">p = s·e<sup>−E/kT</sup> (1)</span>
            {bars([100, 80])}
          </div>
        </div>
      </div>
    </div>
  );
}

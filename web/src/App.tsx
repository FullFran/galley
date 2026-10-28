import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { FileChange, RepoGateway, Repository } from './domain';
import type { Session } from './auth/session';
import { startView } from './containers/boot';
import { RepoPicker } from './containers/RepoPicker';
import { Workspace } from './containers/Workspace';
import { SignedOut } from './ui/SignedOut';

export interface AppProps {
  session: Session;
  gateway: RepoGateway;
}

type View =
  | { name: 'loading' }
  | { name: 'signedOut'; loginFailed: boolean; notice?: string; unsaved?: FileChange[] }
  | { name: 'repos' }
  | { name: 'workspace'; repo: Repository };

const LEAVE_PROMPT = 'You have unsaved changes. Leave anyway?';

export function App({ session, gateway }: AppProps) {
  const [view, setView] = useState<View>({ name: 'loading' });
  const dirty = useRef(false);

  useEffect(() => {
    const search = window.location.search;
    if (search) window.history.replaceState(null, '', window.location.pathname);
    void startView(session, search).then(setView);
  }, [session]);

  const signedOut = useCallback((unsaved: FileChange[] = []) => {
    dirty.current = false;
    const notice = 'Your session has ended. Please sign in again.';
    setView({ name: 'signedOut', loginFailed: false, notice, unsaved });
  }, []);
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const canLeave = () => !dirty.current || window.confirm(LEAVE_PROMPT);

  const signOut = async () => {
    if (!canLeave()) return;
    dirty.current = false;
    await session.logout().catch(() => undefined);
    setView({ name: 'signedOut', loginFailed: false });
  };

  if (view.name === 'loading') return <main class="page muted">Loading…</main>;
  if (view.name === 'signedOut') {
    return (
      <SignedOut
        loginFailed={view.loginFailed}
        notice={view.notice}
        unsaved={view.unsaved}
        onSignIn={() => window.location.assign(session.loginUrl())}
      />
    );
  }
  return (
    <>
      <header class="top-bar">
        <strong>galley</strong>
        {view.name === 'workspace' && (
          <>
            <span class="repo-name">{view.repo.fullName}</span>
            <button type="button" onClick={() => canLeave() && setView({ name: 'repos' })}>
              Repositories
            </button>
          </>
        )}
        <button type="button" class="sign-out" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      {view.name === 'repos' ? (
        <RepoPicker gateway={gateway} onOpen={(repo) => setView({ name: 'workspace', repo })} onAuthRequired={signedOut} />
      ) : (
        <Workspace
          key={view.repo.id}
          gateway={gateway}
          repo={view.repo}
          onAuthRequired={signedOut}
          onDirtyChange={onDirtyChange}
        />
      )}
    </>
  );
}

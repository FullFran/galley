import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FileChange, Person, RepoAccess, RepoGateway, Repository, ReviewGateway } from './domain';
import type { Session } from './auth/session';
import { useT, useTRef } from './i18n';
import { startView } from './containers/boot';
import { Proposals } from './containers/Proposals';
import { RepoPicker } from './containers/RepoPicker';
import { Workspace } from './containers/Workspace';
import type { NavId } from './shell/nav';
import { useSidebar } from './shell/useSidebar';
import type { ShellContext } from './ui/shell/AppShell';
import { CurrentLanguageSwitch } from './ui/shell/LanguageSwitch';
import { Skeleton } from './ui/shell/Skeleton';
import { SignedOut } from './ui/SignedOut';

export interface AppProps {
  session: Session;
  gateway: RepoGateway;
  reviews: ReviewGateway;
}

type View =
  | { name: 'loading' }
  | { name: 'signedOut'; loginFailed: boolean; notice?: string; httpsUrl?: string; unsaved?: FileChange[] }
  | { name: 'repos' }
  | { name: 'workspace'; repo: Repository; settings?: boolean }
  | { name: 'proposals'; repo: Repository };

export function App({ session, gateway, reviews }: AppProps) {
  const t = useT();
  // Stable callbacks read the catalog through a ref, so a language switch does
  // not re-run the screens' effects (the workspace would reload and lose edits).
  const tRef = useTRef();
  const [view, setView] = useState<View>({ name: 'loading' });
  const [user, setUser] = useState<Person>();
  const [admin, setAdmin] = useState(false);
  const [proposals, setProposals] = useState<ShellContext['proposals']>();
  const [proposalsTick, setProposalsTick] = useState(0);
  const dirty = useRef(false);
  const sidebar = useSidebar();

  useEffect(() => {
    const search = window.location.search;
    if (search) window.history.replaceState(null, '', window.location.pathname);
    void startView(session, search, window.location, tRef.current).then(setView);
  }, [session, tRef]);

  const signedIn = view.name === 'repos' || view.name === 'workspace' || view.name === 'proposals';
  const repo = view.name === 'workspace' || view.name === 'proposals' ? view.repo : undefined;

  useEffect(() => {
    if (signedIn && !user) reviews.currentUser().then(setUser, () => undefined);
  }, [signedIn, user, reviews]);

  // One access lookup per repository, shared by the sidebar and the workspace.
  const accessCache = useMemo(() => new Map<number, Promise<RepoAccess>>(), [reviews]);
  const access = useCallback(
    (r: Repository) => {
      let p = accessCache.get(r.id);
      if (!p) {
        p = reviews.access(r);
        accessCache.set(r.id, p);
        p.catch(() => accessCache.delete(r.id));
      }
      return p;
    },
    [reviews, accessCache],
  );

  useEffect(() => {
    setAdmin(false);
    if (!repo) return;
    let active = true;
    access(repo).then(
      (a) => active && setAdmin(a.admin),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [repo?.id, access]);

  // Proposal count and the user's own proposal for the sidebar; optional.
  useEffect(() => {
    setProposals(undefined);
    if (!repo) return;
    let active = true;
    reviews.listProposals(repo).then(
      (list) => {
        if (!active) return;
        const mine = user ? list.find((p) => p.author?.login === user.login)?.number : undefined;
        setProposals({ count: list.length, mine });
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [repo?.id, reviews, user, proposalsTick]);

  const signedOut = useCallback(
    (unsaved: FileChange[] = []) => {
      dirty.current = false;
      setView({ name: 'signedOut', loginFailed: false, notice: tRef.current.app.sessionEnded, unsaved });
    },
    [tRef],
  );
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const refreshProposals = useCallback(() => setProposalsTick((n) => n + 1), []);
  const canLeave = () => !dirty.current || window.confirm(t.app.leavePrompt);

  const signOut = async () => {
    if (!canLeave()) return;
    dirty.current = false;
    await session.logout().catch(() => undefined);
    setUser(undefined);
    setView({ name: 'signedOut', loginFailed: false });
  };

  const navigate = (id: NavId) => {
    if (id === 'repos') {
      if (canLeave()) setView({ name: 'repos' });
      return;
    }
    if (!repo) return;
    if (id === 'proposals' && view.name !== 'proposals') {
      if (canLeave()) setView({ name: 'proposals', repo });
    } else if (id === 'paper' || id === 'files' || id === 'settings') {
      if (view.name !== 'workspace') setView({ name: 'workspace', repo, settings: id === 'settings' });
    }
  };

  if (view.name === 'loading') {
    return (
      <main class="boot">
        <Skeleton lines={3} />
      </main>
    );
  }
  if (view.name === 'signedOut') {
    return (
      <SignedOut
        loginFailed={view.loginFailed}
        notice={view.notice}
        httpsUrl={view.httpsUrl}
        unsaved={view.unsaved}
        onSignIn={() => window.location.assign(session.loginUrl())}
        languageSwitch={<CurrentLanguageSwitch />}
      />
    );
  }

  const shell: ShellContext = {
    repo,
    admin,
    user,
    proposals,
    sidebar,
    onNavigate: navigate,
    onSignOut: () => void signOut(),
    languageSwitch: <CurrentLanguageSwitch />,
  };
  if (view.name === 'repos') {
    return (
      <RepoPicker gateway={gateway} shell={shell} onOpen={(r) => setView({ name: 'workspace', repo: r })} onAuthRequired={signedOut} />
    );
  }
  if (view.name === 'proposals') {
    return <Proposals key={view.repo.id} repos={gateway} reviews={reviews} repo={view.repo} shell={shell} onAuthRequired={signedOut} />;
  }
  return (
    <Workspace
      key={view.repo.id}
      gateway={gateway}
      repo={view.repo}
      access={access}
      shell={shell}
      settingsFirst={view.settings}
      onAuthRequired={signedOut}
      onDirtyChange={onDirtyChange}
      onSaved={refreshProposals}
    />
  );
}

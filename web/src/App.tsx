import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FileChange, Person, RepoAccess, RepoGateway, Repository, ReviewGateway } from './domain';
import type { Session } from './auth/session';
import type { CommentsGateway } from './domain/comments';
import type { DraftSharesGateway } from './admin/api';
import { requestCommentsPanel } from './comments/panelRequest';
import { requestChatPanel } from './chat/panelRequest';
import type { DraftsGateway } from './drafts/http';
import type { ChatGateway } from './chat/http';
import { useTRef } from './i18n';
import { startView } from './containers/boot';
import { Proposals } from './containers/Proposals';
import { RepoPicker } from './containers/RepoPicker';
import { Workspace } from './containers/Workspace';
import { DEFAULT_ADMIN_TAB } from './shell/adminTabs';
import type { NavId } from './shell/nav';
import { formatRoute, parseRoute, rememberRoute, repoRoute, takeRememberedRoute, type RepoRoute, type Route } from './shell/route';
import { useSidebar } from './shell/useSidebar';
import type { CiGateway } from './github/ci';
import type { HistoryGateway } from './github/history';
import type { TeamGateway } from './github/team';
import type { ShellContext } from './ui/shell/AppShell';
import { CurrentLanguageSwitch } from './ui/shell/LanguageSwitch';
import { Skeleton } from './ui/shell/Skeleton';
import { SignedOut } from './ui/SignedOut';
import { Modal } from './ui/shell/Modal';
import { clearUserDrafts, prepareSignOut } from './drafts/signout';
import { draftStore } from './drafts/store';

export interface AppProps {
  session: Session;
  gateway: RepoGateway;
  reviews: ReviewGateway;
  /** galley's comments API (comments anywhere). */
  comments?: CommentsGateway;
  /** galley's drafts API (drafts on other devices). */
  drafts?: DraftsGateway;
  /** galley's chat API (chat per paper). */
  chat?: ChatGateway;
  /** CI builds: status chips and the compiled PDF. */
  ci?: CiGateway;
  /** Owner's draft sharing with the repository's admins. */
  shares?: DraftSharesGateway;
  /** Versions of the default branch, labels and comparisons (History). */
  history?: HistoryGateway;
  /** Asks with due dates and weekly team activity (GitHub issues, commits, pulls). */
  team?: TeamGateway;
}

type View =
  | { name: 'loading' }
  | { name: 'signedOut'; loginFailed: boolean; notice?: string; httpsUrl?: string; unsaved?: FileChange[] }
  | { name: 'repos' }
  | { name: 'workspace'; repo: Repository; route: Extract<RepoRoute, { name: 'workspace' | 'admin' | 'history' | 'references' | 'asks' }> }
  | { name: 'proposals'; repo: Repository; number?: number; author?: string };

const sameRepo = (r: Repository, route: RepoRoute) => r.fullName.toLowerCase() === `${route.owner}/${route.repo}`.toLowerCase();

/**
 * Screens follow the URL fragment (shell/route.ts), so a reload, a shared
 * link or the back button lands where the person was. Leaving the workspace
 * with unsaved edits asks first, also on back and forward.
 */
export function App({ session, gateway, reviews, comments, drafts, chat, ci, shares, history, team }: AppProps) {
  // Stable callbacks read the catalog through a ref, so a language switch does
  // not re-run the screens' effects (the workspace would reload and lose edits).
  const tRef = useTRef();
  const [view, setView] = useState<View>({ name: 'loading' });
  const [user, setUser] = useState<Person>();
  const userRef = useRef(user);
  userRef.current = user;
  /** Drafts that only exist on this device, while the sign-out question is open. */
  const [signOutAsk, setSignOutAsk] = useState<number>();
  const [admin, setAdmin] = useState(false);
  const [proposals, setProposals] = useState<ShellContext['proposals']>();
  const [proposalsTick, setProposalsTick] = useState(0);
  const dirty = useRef(false);
  const sidebar = useSidebar();
  const viewRef = useRef(view);
  viewRef.current = view;
  // The fragment the current screen stands for; back/forward compare with it.
  const shown = useRef('#/');
  const repoList = useRef<Promise<Repository[]>>(undefined);

  const signedIn = view.name === 'repos' || view.name === 'workspace' || view.name === 'proposals';
  const repo = view.name === 'workspace' || view.name === 'proposals' ? view.repo : undefined;
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;

  /** Shows a route: finds its repository (the open one, else the list), else the repository list. */
  const show = useCallback(
    async (route: Route) => {
      shown.current = formatRoute(route);
      if (route.name === 'repos') return setView({ name: 'repos' });
      const current = viewRef.current;
      let found = (current.name === 'workspace' || current.name === 'proposals') && sameRepo(current.repo, route) ? current.repo : undefined;
      if (!found) {
        if (current.name !== 'loading') setView({ name: 'loading' });
        repoList.current ??= gateway.listRepositories();
        const list = await repoList.current.catch(() => {
          repoList.current = undefined;
          return [] as Repository[];
        });
        found = list.find((r) => sameRepo(r, route));
      }
      if (!found) {
        window.history.replaceState(null, '', '#/');
        shown.current = '#/';
        return setView({ name: 'repos' });
      }
      if (route.name === 'proposals') return setView({ name: 'proposals', repo: found, number: route.number, author: route.author });
      setView({ name: 'workspace', repo: found, route });
    },
    [gateway],
  );

  useEffect(() => {
    // Keep the fragment; drop the OAuth callback's query (`?login=failed`).
    const search = window.location.search;
    if (search) window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    void startView(session, search, window.location, tRef.current).then((start) => {
      if (start.name !== 'repos') return setView(start);
      const back = takeRememberedRoute();
      if (back) window.history.replaceState(null, '', formatRoute(back));
      const route = back ?? parseRoute(window.location.hash);
      if (formatRoute(route) !== window.location.hash && window.location.hash !== '') window.history.replaceState(null, '', formatRoute(route));
      void show(route);
    });
  }, [session, tRef, show]);

  /** Leaving the workspace (or its repository) drops unsaved edits. */
  const leavesEdits = (route: Route) => {
    const current = viewRef.current;
    if (current.name !== 'workspace' || !dirty.current) return false;
    return !((route.name === 'workspace' || route.name === 'admin' || route.name === 'history' || route.name === 'references' || route.name === 'asks') && sameRepo(current.repo, route));
  };
  const canLeave = () => !dirty.current || window.confirm(tRef.current.app.leavePrompt);

  const go = useCallback(
    (route: Route) => {
      const hash = formatRoute(route);
      if (hash === shown.current) return;
      if (leavesEdits(route) && !canLeave()) return;
      if (leavesEdits(route)) dirty.current = false;
      window.history.pushState(null, '', hash);
      void show(route);
    },
    [show],
  );

  // Back, forward and edits of the address bar.
  useEffect(() => {
    const onPop = () => {
      if (!signedInRef.current) return;
      const route = parseRoute(window.location.hash);
      const hash = formatRoute(route);
      if (hash === shown.current) return;
      if (leavesEdits(route) && !canLeave()) {
        // Stay: put the current screen's address back.
        window.history.pushState(null, '', shown.current);
        return;
      }
      if (leavesEdits(route)) dirty.current = false;
      if (hash !== window.location.hash) window.history.replaceState(null, '', hash);
      void show(route);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onPop);
    };
  }, [show]);
  useEffect(() => {
    let active = true;
    if (signedIn && !user) reviews.currentUser().then(person => { if (active) setUser(person); }, () => undefined);
    return () => { active = false; };
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

  // Proposal count and how many are the user's own, for the sidebar; optional.
  useEffect(() => {
    setProposals(undefined);
    if (!repo) return;
    let active = true;
    reviews.listProposals(repo).then(
      (list) => {
        if (!active) return;
        const mine = user ? list.filter((p) => p.author?.login === user.login).length : 0;
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
      // The session ended: drafts the server holds leave this browser; the others stay so nothing is lost.
      const login = userRef.current?.login;
      if (login) void clearUserDrafts(login, draftStore(), { keepUnsynced: true });
      setView({ name: 'signedOut', loginFailed: false, notice: tRef.current.app.sessionEnded, unsaved });
    },
    [tRef],
  );
  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const refreshProposals = useCallback(() => setProposalsTick((n) => n + 1), []);

  const signOut = async () => {
    const login = user?.login;
    if (!login) {
      if (!canLeave()) return;
      return finishSignOut();
    }
    // Edits are drafts: what reached the server survives; what only exists here needs a yes.
    const { unsynced } = await prepareSignOut(login, draftStore());
    if (unsynced > 0) setSignOutAsk(unsynced);
    else await finishSignOut();
  };

  const finishSignOut = async () => {
    setSignOutAsk(undefined);
    const login = userRef.current?.login;
    if (login) await clearUserDrafts(login, draftStore());
    dirty.current = false;
    // Cancel user-scoped UI work before the session cookie is removed.
    setUser(undefined);
    setView({ name: 'signedOut', loginFailed: false });
    await session.logout().catch(() => undefined);
    window.history.replaceState(null, '', '#/');
    shown.current = '#/';
    setView({ name: 'signedOut', loginFailed: false });
  };

  const navigate = (id: NavId) => {
    if (!repo) return;
    const base = repoRoute(repo.fullName);
    if (id === 'proposals') go({ name: 'proposals', ...base });
    else if (id === 'admin') go({ name: 'admin', ...base, tab: DEFAULT_ADMIN_TAB });
    else if (id === 'history') go({ name: 'history', ...base });
    else if (id === 'asks') go({ name: 'asks', ...base });
    else if (id === 'references') go({ name: 'references', ...base });
    else if (id === 'comments') {
      requestCommentsPanel();
      go({ name: 'workspace', ...base });
    } else if (id === 'chat') {
      requestChatPanel();
      go({ name: 'workspace', ...base });
    } else go({ name: 'workspace', ...base });
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
        onSignIn={() => {
          // GitHub sign in loses the fragment; come back to it afterwards.
          rememberRoute(window.location.hash);
          window.location.assign(session.loginUrl());
        }}
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
    onRepos: () => go({ name: 'repos' }),
    onSignOut: () => void signOut(),
    ci,
    team,
  };
  const m = tRef.current.drafts;
  const signOutDialog = (
    <Modal open={signOutAsk !== undefined} onClose={() => setSignOutAsk(undefined)} labelledBy="signout-title" class="signout-dialog">
      <h2 id="signout-title">{m.signOutTitle}</h2>
      <p>{m.signOutUnsynced(signOutAsk ?? 0)}</p>
      <div class="actions">
        <button type="button" onClick={() => setSignOutAsk(undefined)}>
          {m.signOutCancel}
        </button>
        <button type="button" class="primary" onClick={() => void finishSignOut()}>
          {m.signOutDelete}
        </button>
      </div>
    </Modal>
  );
  if (view.name === 'repos') {
    return (
      <>
        {signOutDialog}
        <RepoPicker
          gateway={gateway}
          shell={shell}
          onOpen={(r) => go({ name: 'workspace', ...repoRoute(r.fullName) })}
          onAuthRequired={signedOut}
        />
      </>
    );
  }
  if (view.name === 'proposals') {
    const base = repoRoute(view.repo.fullName);
    return (
      <>
        {signOutDialog}
        <Proposals
          key={view.repo.id}
          repos={gateway}
          reviews={reviews}
          repo={view.repo}
          number={view.number}
          author={view.author}
          onOpen={(number) => go({ name: 'proposals', ...base, number })}
          onAllAuthors={() => go({ name: 'proposals', ...base })}
          shell={shell}
          onAuthRequired={signedOut}
        />
      </>
    );
  }
  return (
    <>
      {signOutDialog}
      <Workspace
        key={view.repo.id}
        gateway={gateway}
        repo={view.repo}
        route={view.route}
        onRoute={go}
        access={access}
        shell={shell}
        onAuthRequired={signedOut}
        onDirtyChange={onDirtyChange}
        onSaved={refreshProposals}
        comments={comments}
        drafts={drafts}
        chat={chat}
        shares={shares}
        history={history}
      />
    </>
  );
}

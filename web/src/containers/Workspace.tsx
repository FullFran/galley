import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  AuthRequiredError,
  type FileChange,
  type RepoAccess,
  type RepoGateway,
  type Repository,
  type UpstreamStatus,
  type WorkingState,
} from '../domain';
import type { DefinitionTarget } from '../editor/definition';
import {
  bringIn,
  conflictUrl,
  createUpstreamWatcher,
  rebase,
  saveWithUpstream,
  shouldOffer,
  unresolvedPaths,
  type Upstreamed,
} from '../workspace/upstream';
import { resolvedText, type MergeRegion } from '../workspace/merge3';
import { MergeResolver } from '../ui/MergeResolver';
import { useProjectIndex } from './useProjectIndex';
import { useAuthoring } from './useAuthoring';
import { EditorModeSwitch } from '../ui/EditorModeSwitch';
import { FigureLightbox, type FigureState } from '../ui/FigureLightbox';
import { UpstreamBanner, type UpstreamBannerState } from '../ui/UpstreamBanner';
import { onPrefsChange, resolveEditorMode, writePrefs, type EditorMode } from '../shell/prefs';
import { CONFIG_PATH, visibleFiles, type ProjectConfig } from '../config/project';
import { applySaved, defaultMessage, describeError, dirtyPaths, unsavedChanges, type Buffers } from '../workspace/model';
import { useT, useTRef } from '../i18n';
import { isPanelTab, leaveAdminArea, type AdminTabId } from '../shell/adminTabs';
import type { DraftSharesGateway } from '../admin/api';
import { useDraftShare } from '../ui/admin/useDraftShare';
import type { NavId } from '../shell/nav';
import { dismissSetup, isSetupDismissed, readContentsTab, readPrefs, writeContentsTab, type ContentsTab } from '../shell/prefs';
import { MAX_FIGURE_BYTES, figureDataUrl } from '../editor/figure';
import { repoRoute, type RepoRoute } from '../shell/route';
import { extractOutline, type OutlineItem } from '../shell/outline';
import { filesInView, readViewAs, writeViewAs, type ViewAs } from '../config/viewAs';
import { mainDocument } from '../workspace/session';
import { fileKind } from '../workspace/tree';
import { Editor } from '../ui/Editor';
import { Preview } from './Preview';
import { FileTree } from '../ui/FileTree';
import { StatusBanner, type SaveStatus } from '../ui/StatusBanner';
import { SetupBanner } from '../ui/config/SetupBanner';
import { AdminArea } from '../ui/shell/AdminArea';
import { AppShell, MoreMenu, type Crumb, type ShellContext } from '../ui/shell/AppShell';
import { Contents } from '../ui/shell/Contents';
import { Icon } from '../ui/shell/icons';
import { Outline } from '../ui/shell/Outline';
import { SaveControl } from '../ui/shell/SaveControl';
import { Skeleton } from '../ui/shell/Skeleton';
import { Toast } from '../ui/shell/Toasts';
import { ViewSwitch, type PaneView } from '../ui/shell/ViewSwitch';
import { ViewMenu } from '../ui/shell/ViewMenu';
import { escapeExitsFocus, layoutOf, overlayOpen, showsPdf, switchPressed, togglePane, chooseFromSwitch, type Layout, type ViewChange } from '../shell/viewOptions';
import { CompiledPdfView } from '../ui/ci/CompiledPdf';
import { useFits } from '../shell/useFits';
import { matchShortcut, typingAt } from '../shell/shortcuts';
import type { ConfigSaved } from './ProjectSettings';
import type { CommentsGateway } from '../domain/comments';
import { useComments } from './Comments';
import type { DraftsGateway } from '../drafts/http';
import type { ChatGateway } from '../chat/http';
import { useDrafts } from './useDrafts';
import { useChat } from './Chat';
import type { HistoryGateway } from '../github/history';
import { prepareRestore, type RestoreChange } from '../history/restore';
import { LastVisitBannerView, useLastVisit, useRestore } from './useHistory';
import type { EditorView } from '@codemirror/view';
import { useSymbolPalette } from './useSymbolPalette';
import { useFindReplace } from './useFindReplace';
import { isBib } from '../editor/projectIndex';
import { useWritingAids } from './useWritingAids';
import { useTeam } from './useTeam';

// The YAML parser, the wizard and the settings form load on demand.
type SettingsModule = typeof import('./ProjectSettings');
const loadSettings = () => import('./ProjectSettings');
// The admin panel (C6) is its own chunk, loaded when an admin opens one of its tabs.
type PanelsModule = typeof import('../ui/admin/AdminPanels');
const loadPanels = () => import('../ui/admin/AdminPanels');
// The History screen loads on demand too.
type HistoryModule = typeof import('./History');
const loadHistory = () => import('./History');
// The references manager (BibTeX editing, Crossref) loads on demand too.
type ReferencesModule = typeof import('./References');
const loadReferences = () => import('./References');
// My asks and Team activity load on demand too.
type AsksModule = typeof import('./MyAsks');
const loadAsks = () => import('./MyAsks');
type TeamActivityModule = typeof import('./TeamActivity');
const loadTeamActivity = () => import('./TeamActivity');

export interface WorkspaceProps {
  gateway: RepoGateway;
  repo: Repository;
  /** What the user may do in the repository; admins get project settings. */
  access: (repo: Repository) => Promise<RepoAccess>;
  shell: ShellContext;
  /** Where the URL points inside this repository: a file, or an admin tab. */
  route: Extract<RepoRoute, { name: 'workspace' | 'admin' | 'history' | 'references' | 'asks' }>;
  /** Moves to another route (App keeps the URL and the unsaved-changes guard). */
  onRoute: (route: RepoRoute) => void;
  /** Called with the edits that are not saved yet, so they can stay visible. */
  onAuthRequired: (unsaved: FileChange[]) => void;
  onDirtyChange: (dirty: boolean) => void;
  /** A save created or updated a proposal. */
  onSaved?: () => void;
  /** galley's comments API; without it the comments panel is not offered. */
  comments?: CommentsGateway;
  /** Owner's draft sharing with admins; without it the ⋯ menu entry is not offered. */
  shares?: DraftSharesGateway;
  /** galley's drafts API; without it drafts stay in this browser. */
  drafts?: DraftsGateway;
  /** galley's chat API; without it the chat is not offered. */
  chat?: ChatGateway;
  /** Versions, labels and comparisons; without it History is not offered. */
  history?: HistoryGateway;
}

type Heading = Extract<OutlineItem, { kind: 'heading' }>;
const NO_FILES: string[] = [];

export function Workspace({ gateway, repo, route, onRoute, access, shell, onAuthRequired, onDirtyChange, onSaved, comments: commentsGateway, drafts: draftsGateway, chat: chatGateway, shares, history }: WorkspaceProps) {
  const t = useT();
  // Callbacks read the catalog through a ref: a language switch must not
  // re-create `load` (that would reload the repository and drop edits).
  const tRef = useTRef();
  const [working, setWorking] = useState<WorkingState>();
  const [project, setProject] = useState<ProjectConfig>({ kind: 'missing' });
  const [admin, setAdmin] = useState(false);
  const [settings, setSettings] = useState<SettingsModule>();
  const [adminPanels, setAdminPanels] = useState<PanelsModule>();
  const [buffers, setBuffers] = useState<Buffers>({});
  const [openPath, setOpenPath] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [jump, setJump] = useState<{ line: number; id?: string; text: string; seq: number }>();
  // When the main column is too narrow for both, the editor and the preview share one pane.
  const [view, setView] = useState<PaneView>('edit');
  // Admins can look at the paper as co-authors see it.
  const [viewAs, setViewAs] = useState<ViewAs>(() => readViewAs(repo.fullName));
  const [contentsTab, setContentsTab] = useState<ContentsTab>(() => readContentsTab(repo.fullName));
  const [setupDismissed, setSetupDismissed] = useState(() => isSetupDismissed(repo.fullName));
  const [recompileSeq, setRecompileSeq] = useState(0);
  const [noteRequest, setNoteRequest] = useState(0);
  const adminTab: AdminTabId | undefined = route.name === 'admin' ? route.tab : undefined;
  const historyRoute = route.name === 'history' ? route : undefined;
  const asksRoute = route.name === 'asks';
  const [asksModule, setAsksModule] = useState<AsksModule>();
  const [teamActivity, setTeamActivity] = useState<TeamActivityModule>();
  const [historyModule, setHistoryModule] = useState<HistoryModule>();
  // Files restored from History, waiting for the next save.
  const restored = useRestore();
  const lastVisit = useLastVisit(history, gateway, repo, shell.user?.login);
  const refsRoute = route.name === 'references' ? route : undefined;
  const [refsModule, setRefsModule] = useState<ReferencesModule>();
  // Screens without the editor and preview panes.
  const paneless = adminTab !== undefined || historyRoute !== undefined || refsRoute !== undefined || asksRoute;
  const routePath = route.name === 'workspace' ? route.path : undefined;
  const routePathRef = useRef(routePath);
  routePathRef.current = routePath;
  const base = repoRoute(repo.fullName);
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  // Editor preferences (Writing/Code, Vim) follow the Preferences dialog live.
  const [prefs, setPrefs] = useState(readPrefs);
  useEffect(() => onPrefsChange(setPrefs), []);
  // View options (the View menu, Preferences): layout, text/preview toggle, focus mode.
  // Editor and preview fit side by side from 52rem of width (the same width as styles.css).
  const [fits, measureRef] = useFits(52);
  const layout = layoutOf(prefs);
  // Editor + compiled PDF: the second pane shows the default branch's PDF from CI.
  const pdfLayout = showsPdf(layout);
  const focus = !paneless && prefs.focus === true;
  const setLayout = (next: Layout) => writePrefs({ ...readPrefs(), layout: next });
  const setFocus = (on: boolean) => writePrefs({ ...readPrefs(), focus: on });
  // PDF layout: Edit | PDF shows one pane alone even while both fit (not stored; choosing a layout resets it).
  const [single, setSingle] = useState(false);
  useEffect(() => setSingle(false), [layout]);
  const applyView = (change: ViewChange) => {
    if ('layout' in change) return setLayout(change.layout);
    setView(change.view);
    if (change.single) setSingle(true);
  };
  const chooseLayout = (next: Layout) => {
    setSingle(false);
    setLayout(next);
  };
  const toggleView = () => applyView(togglePane(layout, fits, view, single));
  const viewKeys = useRef<(e: KeyboardEvent) => void>(undefined);
  viewKeys.current = (e) => {
    if (escapeExitsFocus(e, focus, overlayOpen(document))) {
      setFocus(false);
      return;
    }
    if (paneless || matchShortcut(e, typingAt(e)) !== 'togglePane') return;
    e.preventDefault();
    toggleView();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => viewKeys.current?.(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // The default branch: new changes are offered, never merged while editing.
  const [upstream, setUpstream] = useState<UpstreamStatus>();
  const [dismissedHead, setDismissedHead] = useState<string>();
  const [bringing, setBringing] = useState(false);
  const [upstreamNote, setUpstreamNote] = useState<{ kind: 'conflict' }>();
  // A short message for screen readers (go to definition) and a visible notice.
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState<string>();
  const [editorJump, setEditorJump] = useState<{ line: number; seq: number }>();
  // Bumped when the open file's text was replaced from the repository.
  const [editorRev, setEditorRev] = useState(0);
  const [figure, setFigure] = useState<{ path: string; state: FigureState }>();

  const fail = useCallback(
    (err: unknown, show: (message: string) => void) => {
      if (err instanceof AuthRequiredError) onAuthRequired(unsavedChanges(buffersRef.current));
      else show(describeError(err, tRef.current));
    },
    [onAuthRequired, tRef],
  );

  const load = useCallback(async () => {
    setLoadError(undefined);
    try {
      const state = await gateway.openRepository(repo);
      // Anything but a confirmed admin sees the co-author view (fail closed).
      const [config, isAdmin] = await Promise.all([
        state.files.includes(CONFIG_PATH)
          ? import('../config/load').then(({ loadProjectConfig }) =>
              loadProjectConfig(state.files, (path) => gateway.readFile(repo, path, state.headSha)),
            )
          : Promise.resolve<ProjectConfig>({ kind: 'missing' }),
        access(repo).then(
          (a) => a.admin,
          () => false,
        ),
      ]);
      setProject(config);
      setAdmin(isAdmin);
      setBuffers({});
      setOpenPath(undefined);
      setWorking(state);
      // Open the main document (or the file that was open before a reload).
      const visible = filesInView(state.files, config, isAdmin, readViewAs(repo.fullName)).filter((p) => fileKind(p) !== 'binary');
      const previous = openPathRef.current;
      const asked = routePathRef.current;
      const target =
        previous && visible.includes(previous)
          ? previous
          : asked && visible.includes(asked)
            ? asked
            : mainDocument(visible, config.kind === 'valid' ? config.config.entry : undefined);
      if (target) {
        try {
          const text = await gateway.readFile(repo, target, state.headSha);
          setBuffers((b) => (b[target] ? b : { ...b, [target]: { base: text, text } }));
          setOpenPath(target);
        } catch (err) {
          fail(err, setFileError);
        }
      }
      return true;
    } catch (err) {
      fail(err, setLoadError);
      return false;
    }
  }, [gateway, repo, access, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = dirtyPaths(buffers);
  // Figure uploads and new sections: pending changes for the next save.
  const [insertReq, setInsertReq] = useState<{ text: string; at?: number; block?: boolean; seq: number }>();
  // Values computed further down this render; read through a ref (the previous render's until then).
  const late = useRef<{ main?: string; label: (path: string) => string; ids: ReadonlySet<string> }>({ label: (p) => p, ids: new Set() });
  const authoring = useAuthoring({
    gateway,
    repo,
    working,
    project,
    admin,
    buffers,
    setBuffers,
    openPath,
    main: () => late.current.main,
    labelOf: (path) => late.current.label(path),
    ids: () => late.current.ids,
    onReplaced: (path) => path === openPathRef.current && setEditorRev((n) => n + 1),
    notify: setNotice,
    insert: (text, at) => setInsertReq((r) => ({ text, at, block: true, seq: (r?.seq ?? 0) + 1 })),
    canInsert: !paneless && openPath !== undefined && /\.(qmd|md|markdown)$/i.test(openPath) && !buffers[openPath]?.merge,
  });
  const hasDirty = dirty.length > 0 || authoring.uploads.length > 0 || restored.pending.length > 0;
  useEffect(() => onDirtyChange(hasDirty), [hasDirty, onDirtyChange]);
  useEffect(() => {
    if (!hasDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasDirty]);

  const visible = working
    ? filesInView([...new Set([...working.files, ...authoring.created, ...restored.created])], project, admin, viewAs).filter((p) => !restored.deleted.includes(p))
    : [];
  const changeViewAs = (mode: ViewAs) => {
    setViewAs(mode);
    writeViewAs(repo.fullName, mode);
  };
  const labels = { ...(project.kind === 'valid' ? project.config.labels : {}), ...authoring.labels };
  const label = (path: string) => labels[path] ?? path.slice(path.lastIndexOf('/') + 1);
  const entry = project.kind === 'valid' ? project.config.entry : undefined;
  const main = mainDocument(visible.filter((p) => fileKind(p) !== 'binary'), entry);
  const openText = openPath ? buffers[openPath]?.text : undefined;
  const outline = useMemo(() => (openText === undefined ? [] : extractOutline(openText)), [openText]);
  const team = useTeam({
    team: shell.team,
    gateway,
    repo,
    working,
    project,
    admin,
    me: shell.user?.login,
    buffers,
    setBuffers,
    onReplaced: (path) => path === openPathRef.current && setEditorRev((n) => n + 1),
    notify: setNotice,
    onAuthRequired: () => onAuthRequired(unsavedChanges(buffersRef.current)),
  });

  const showFile = (path: string, follow: boolean) => {
    setOpenPath(path);
    // The URL follows the open file, so a reload comes back to it.
    if (follow && (route.name !== 'workspace' || route.path !== path)) onRoute({ name: 'workspace', ...base, path });
  };

  /** `follow`: put the file in the URL (false when the URL already moved, on back/forward). */
  const openFile = async (path: string, follow = true) => {
    setFileError(undefined);
    shell.sidebar.dispatch({ type: 'navigate' });
    if (path !== openPath) {
      setJump(undefined);
      setEditorJump(undefined);
    }
    if (!visible.includes(path)) return;
    if (buffers[path] || !working) {
      showFile(path, follow);
      return;
    }
    try {
      const text = await gateway.readFile(repo, path, working.headSha);
      setBuffers((b) => (b[path] ? b : { ...b, [path]: { base: text, text } }));
      showFile(path, follow);
    } catch (err) {
      fail(err, setFileError);
    }
  };

  // Back/forward to another file of this repository.
  const loaded = working !== undefined;
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  const lastRoutePath = useRef(routePath);
  useEffect(() => {
    if (!loaded || lastRoutePath.current === routePath) return;
    lastRoutePath.current = routePath;
    const target = routePath ?? main;
    if (target && target !== openPathRef.current) void openFileRef.current(target, false);
  }, [routePath, loaded, main]);

  const goToHeading = (item: Heading) => {
    shell.sidebar.dispatch({ type: 'navigate' });
    if (paneless) onRoute({ name: 'workspace', ...base, path: openPath });
    setJump((j) => ({ line: item.line, id: item.id, text: item.title, seq: (j?.seq ?? 0) + 1 }));
    setEditorJump((j) => ({ line: item.line, seq: (j?.seq ?? 0) + 1 }));
  };

  // Writing | Code: the person's choice, else the paper's default.
  const configuredMode = project.kind === 'valid' ? project.config.editor?.defaultMode : undefined;
  const mode = resolveEditorMode(prefs.editorMode, configuredMode, admin);
  const changeMode = (next: EditorMode) => writePrefs({ ...readPrefs(), editorMode: next });

  // Watch the default branch while the workspace is open.
  const watcher = useRef<ReturnType<typeof createUpstreamWatcher>>(undefined);
  const headSha = working?.headSha;
  useEffect(() => {
    if (!loaded) return;
    const w = createUpstreamWatcher({
      defaultHead: () => gateway.defaultHead(repo),
      upstream: (head) => gateway.upstream(repo, head),
      onStatus: setUpstream,
    });
    watcher.current = w;
    if (headSha) w.start(headSha);
    return () => {
      w.dispose();
      watcher.current = undefined;
    };
    // One watcher per repository; head changes go through setHead below.
  }, [gateway, repo, loaded]);
  useEffect(() => {
    if (headSha) watcher.current?.setHead(headSha);
  }, [headSha]);

  /** Moves the workspace onto a new head that has the default branch in it; edits are kept. */
  const moveToUpstream = (up: Upstreamed) => {
    const open = openPathRef.current;
    // Computed once here for the messages; the state update repeats it on the latest buffers.
    const outcome = rebase(buffersRef.current, up.bases, up.before);
    setWorking((w) => w && { ...w, headSha: up.headSha, files: up.files, truncated: up.truncated, blobs: up.blobs ?? {} });
    setBuffers((b) => rebase(b, up.bases, up.before).buffers);
    if (open && open in up.bases) {
      if (!outcome.buffers[open]) setOpenPath(undefined);
      // The editor shows its initial text only; remount it with the new one.
      else setEditorRev((n) => n + 1);
    }
    setUpstream(undefined);
    if (upstreamNote?.kind === 'conflict') setUpstreamNote(undefined);
    if (outcome.merged.length) setNotice(t.upstream.merged(repo.defaultBranch, outcome.merged.join(', ')));
    return outcome;
  };

  const bringInNow = async () => {
    if (!working || bringing) return;
    setBringing(true);
    try {
      // The snapshot is taken before any await (see `rebase`).
      const result = await bringIn(gateway, repo, working.headSha, buffersRef.current);
      if (result.kind === 'conflict') setUpstreamNote({ kind: 'conflict' });
      else if (result.kind === 'current') setUpstream(undefined);
      else {
        const outcome = moveToUpstream(result.upstream);
        if (!outcome.merged.length && !outcome.conflicted.length) setNotice(t.upstream.broughtIn);
      }
    } catch (err) {
      fail(err, setFileError);
    } finally {
      setBringing(false);
    }
  };

  // Go to definition: a file, a place in a file, or a figure.
  const indexState = useProjectIndex(
    gateway,
    repo,
    working?.headSha,
    working?.files ?? NO_FILES,
    working?.blobs,
    buffers,
    project.kind === 'valid' ? project.config.entry : undefined,
  );
  const indexRef = useRef(indexState.index);
  indexRef.current = indexState.index;
  late.current = { main, label, ids: new Set((indexState.index?.labels ?? []).map((l) => l.id)) };
  const aids = useWritingAids({
    gateway,
    repo,
    working,
    index: indexState.index,
    limits: project.kind === 'valid' ? project.config.limits : undefined,
    mainText: main ? buffers[main]?.text : undefined,
    openPath,
  });
  const announce = (text: string) => setAnnouncement(text);

  const openAt = async (path: string, line?: number) => {
    if (!visible.includes(path)) {
      setNotice(t.editor.notInList(path));
      announce(t.editor.notInList(path));
      return;
    }
    await openFile(path);
    if (line !== undefined) setEditorJump((j) => ({ line, seq: (j?.seq ?? 0) + 1 }));
    announce(line === undefined ? t.editor.opened(path) : t.editor.openedAt(path, line));
  };

  // A figure waiting in an upload is not in the repository yet: use its bytes.
  const fileBytes = (path: string): Promise<Uint8Array> => {
    const pending = authoring.uploads.find((u) => u.path === path);
    if (pending) return Promise.resolve(pending.bytes);
    if (!working) return Promise.reject(new Error('no working tree'));
    return gateway.readBytes(repo, path, working.headSha);
  };

  // A PDF from the file tree opens read-only in a new tab, from a blob: URL
  // (the CSP has no frame-src for blob:, so it is not embedded). If the
  // browser blocks the tab, the file is downloaded instead.
  const openPdf = async (path: string) => {
    let bytes: Uint8Array;
    try {
      bytes = await fileBytes(path);
    } catch {
      setNotice(t.files.viewFailed(path));
      announce(t.files.viewFailed(path));
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
    const tab = window.open(url, '_blank');
    if (tab) {
      tab.opener = null;
      announce(t.editor.opened(path));
    } else {
      const link = document.createElement('a');
      link.href = url;
      link.download = path.slice(path.lastIndexOf('/') + 1);
      link.click();
      setNotice(t.files.pdfBlocked(path));
      announce(t.files.pdfBlocked(path));
    }
    // The new tab has loaded the document well before this.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const viewFile = (path: string, as: 'image' | 'pdf') => void (as === 'pdf' ? openPdf(path) : showFigure(path));

  const showFigure = async (path: string) => {
    if (!working) return;
    const pdf = /\.pdf$/i.test(path);
    setFigure({ path, state: pdf ? { kind: 'pdf' } : { kind: 'loading' } });
    announce(t.editor.opened(path));
    if (pdf) return;
    // The tree gives the size, so a huge file is never downloaded.
    const size = working.blobs[path]?.size;
    if (size !== undefined && size > MAX_FIGURE_BYTES) {
      setFigure({ path, state: { kind: 'too-large' } });
      return;
    }
    try {
      const bytes = await fileBytes(path);
      const url = bytes.length <= MAX_FIGURE_BYTES ? figureDataUrl(bytes, path) : undefined;
      setFigure((f) => (f?.path === path ? { path, state: url ? { kind: 'ready', url } : { kind: 'failed' } } : f));
    } catch {
      setFigure((f) => (f?.path === path ? { path, state: { kind: 'failed' } } : f));
    }
  };

  const goToDefinition = (target: DefinitionTarget) => {
    switch (target.kind) {
      case 'file':
        return void openAt(target.path);
      case 'citation':
        if (!visible.includes(target.path)) return void openAt(target.path, target.line);
        announce(t.references.title);
        return onRoute({ name: 'references', ...base, key: target.key });
      case 'label':
        return void openAt(target.path, target.line);
      case 'image':
        return void showFigure(target.path);
      case 'missing':
        setNotice(t.editor.notFound(target.name));
        announce(t.editor.notFound(target.name));
    }
  };
  const goToDefinitionRef = useRef(goToDefinition);
  goToDefinitionRef.current = goToDefinition;
  const assist = useMemo(
    () => ({ index: () => indexRef.current, t: () => tRef.current, onDefinition: (target: DefinitionTarget) => goToDefinitionRef.current(target) }),
    [tRef],
  );

  const comments = useComments({
    gateway: commentsGateway,
    repo,
    headSha: working?.headSha,
    openPath,
    openText,
    access,
    readText: async (path) => {
      if (!working || !visible.includes(path) || fileKind(path) === 'binary') return undefined;
      return buffersRef.current[path]?.text ?? gateway.readFile(repo, path, working.headSha);
    },
    onOpenAt: (path, line) => void openAt(path, line),
    // The PDF layout hides the live preview: show it again (side by side) for the jump.
    onShowPreview: () => (layout === 'editor' ? setLayout('preview') : layout === 'pdf' ? setLayout('both') : setView('preview')),
    onNotice: setNotice,
    onAuthRequired: () => onAuthRequired(unsavedChanges(buffersRef.current)),
  });

  // Drafts: kept while typing, restored on open, deleted once saved (applySaved makes the buffers clean).
  const drafts = useDrafts({
    gateway: draftsGateway,
    repos: gateway,
    repo,
    user: shell.user?.login,
    working,
    visible,
    buffers,
    setBuffers,
    label,
    onReplaced: (path) => path === openPathRef.current && setEditorRev((n) => n + 1),
  });
  const chat = useChat({ gateway: chatGateway, repo, onAuthRequired: () => onAuthRequired(unsavedChanges(buffersRef.current)) });
  // One side panel at a time: the one opened last wins.
  const panels = useRef({ comments: false, chat: false });
  useEffect(() => {
    const before = panels.current;
    panels.current = { comments: comments.open, chat: chat.open };
    if (!comments.open || !chat.open) return;
    if (!before.comments) chat.close();
    else if (!before.chat) comments.close();
  });

  const save = async () => {
    if (!working || !hasDirty || status.kind === 'saving') return;
    setStatus({ kind: 'saving' });
    const extra = authoring.extra();
    const note = message.trim() || authoring.defaultMessage || restored.message || defaultMessage(dirty, t);
    // The default branch comes in first; the save lands on top of it.
    const outcome = await saveWithUpstream(gateway, repo, buffers, note, working.headSha, t, [...extra.changes, ...restored.pending]);
    // Whatever happened to the commit, a merge that landed is the new head.
    if ('upstream' in outcome && outcome.upstream) moveToUpstream(outcome.upstream);
    switch (outcome.kind) {
      case 'unresolved':
        setStatus({ kind: 'error', message: t.upstream.saveUnresolved(outcome.paths.join(', ')) });
        break;
      case 'upstream-conflict':
        setUpstreamNote({ kind: 'conflict' });
        setStatus({ kind: 'error', message: t.upstream.saveConflict });
        break;
      case 'upstream-conflicted':
        setStatus({ kind: 'error', message: t.upstream.saveUnresolved(outcome.paths.join(', ')) });
        break;
      case 'saved': {
        const savedPaths = new Set(outcome.saved.filter((c) => !c.delete).map((c) => c.path));
        const deletedPaths = new Set(outcome.saved.filter((c) => c.delete).map((c) => c.path));
        // Saved files have new blobs; the index reads them by commit until the next tree listing.
        setWorking(
          (w) =>
            w && {
              ...w,
              headSha: outcome.headSha,
              branchExists: true,
              // New sections and uploads are now in the repository.
              files: [...new Set([...w.files, ...savedPaths])].filter((p) => !deletedPaths.has(p)).sort(),
              blobs: Object.fromEntries(Object.entries(w.blobs).filter(([p]) => !savedPaths.has(p) && !deletedPaths.has(p))),
            },
        );
        setBuffers((b) => applySaved(b, outcome.saved));
        authoring.committed(extra.ids);
        restored.committed();
        setMessage('');
        setStatus({ kind: 'saved', pullRequestUrl: outcome.pullRequestUrl });
        onSaved?.();
        break;
      }
      case 'conflict':
        setStatus({ kind: 'conflict', copies: outcome.copies, reloaded: false });
        break;
      case 'auth':
        setStatus({ kind: 'idle' });
        onAuthRequired(unsavedChanges(buffersRef.current));
        break;
      case 'error':
        setStatus({ kind: 'error', message: outcome.message });
    }
  };

  const toEditor = () => onRoute({ name: 'workspace', ...base, path: openPathRef.current });

  const configSaved = (saved: ConfigSaved) => {
    setProject(saved.project);
    setWorking(
      (w) =>
        w && {
          ...w,
          headSha: saved.headSha,
          branchExists: true,
          files: w.files.includes(CONFIG_PATH) ? w.files : [...w.files, CONFIG_PATH].sort(),
        },
    );
    setBuffers((b) => applySaved(b, [{ path: CONFIG_PATH, content: saved.content }]));
    toEditor();
    setStatus({ kind: 'saved', pullRequestUrl: saved.pullRequestUrl });
    onSaved?.();
  };

  // The settings form loads on demand, when its admin tab opens.
  useEffect(() => {
    if (!admin || adminTab !== 'settings' || settings) return;
    loadSettings().then(setSettings, (err: unknown) => fail(err, setFileError));
  }, [admin, adminTab, settings, fail]);

  // The admin panel loads on demand too; a confirmed non-admin is sent back to the paper.
  useEffect(() => {
    if (!admin || !isPanelTab(adminTab) || adminPanels) return;
    loadPanels().then(setAdminPanels, (err: unknown) => fail(err, setFileError));
  }, [admin, adminTab, adminPanels, fail]);
  useEffect(() => {
    if (loaded && leaveAdminArea(adminTab, admin)) onRoute({ name: 'workspace', ...base });
  }, [loaded, adminTab, admin]);

  /** "Copy into my own draft": a shared draft's text becomes the admin's own unsaved edit. */
  const copyIntoDraft = async (path: string, content: string) => {
    const m = t.adminPanel.shared;
    if (!working || !visible.includes(path)) return setNotice(m.copyMissing(path));
    const current = buffersRef.current[path];
    if (current && current.text !== current.base && !window.confirm(m.copyReplace(path))) return;
    try {
      const baseText = current?.base ?? (await gateway.readFile(repo, path, working.headSha));
      setBuffers((b) => ({ ...b, [path]: { base: b[path]?.base ?? baseText, text: content } }));
      setEditorRev((n) => n + 1);
      setOpenPath(path);
      onRoute({ name: 'workspace', ...base, path });
      setNotice(m.copied(path));
    } catch (err) {
      fail(err, setFileError);
    }
  };

  const draftShare = useDraftShare({
    gateway: adminTab ? undefined : shares,
    repoId: repo.id,
    path: openPath,
    t,
    notify: setNotice,
    onAuthRequired: () => onAuthRequired(unsavedChanges(buffersRef.current)),
  });
  // The references manager: its chunk, and the .bib files as buffers (edits are ordinary pending edits).
  const bibPaths = visible.filter(isBib);
  const bibKey = bibPaths.join('\u0000');
  const [bibFailed, setBibFailed] = useState(false);
  useEffect(() => {
    if (!refsRoute || refsModule) return;
    loadReferences().then(setRefsModule, (err: unknown) => fail(err, setFileError));
  }, [refsRoute !== undefined, refsModule, fail]);
  useEffect(() => {
    if (!refsRoute || !working) return;
    const missing = bibKey ? bibKey.split('\u0000').filter((p) => !buffersRef.current[p]) : [];
    let active = true;
    for (const path of missing) {
      gateway.readFile(repo, path, working.headSha).then(
        (text) => active && setBuffers((b) => (b[path] ? b : { ...b, [path]: { base: text, text } })),
        (err: unknown) => {
          if (!active) return;
          setBibFailed(true);
          fail(err, setFileError);
        },
      );
    }
    return () => {
      active = false;
    };
  }, [refsRoute !== undefined, bibKey, working?.headSha, gateway, repo, fail]);

  const openSettings = () => onRoute({ name: 'admin', ...base, tab: 'settings' });

  useEffect(() => {
    if (!historyRoute || historyModule) return;
    loadHistory().then(setHistoryModule, (err: unknown) => fail(err, setFileError));
  }, [historyRoute !== undefined, historyModule, fail]);

  useEffect(() => {
    if (!asksRoute || asksModule) return;
    loadAsks().then(setAsksModule, (err: unknown) => fail(err, setFileError));
  }, [asksRoute, asksModule, fail]);
  useEffect(() => {
    if (!admin || adminTab !== 'team' || teamActivity) return;
    loadTeamActivity().then(setTeamActivity, (err: unknown) => fail(err, setFileError));
  }, [admin, adminTab, teamActivity, fail]);

  /** Restored files become unsaved changes (never a commit); then back to the editor. */
  const restoreFromHistory = async (changes: RestoreChange[], when: string) => {
    if (!working) return;
    const head = working.headSha;
    const prepared = await prepareRestore(changes, buffersRef.current, working.files, (path) =>
      gateway.readFile(repo, path, head).catch(() => ''),
    );
    const result = restored.apply(buffersRef.current, prepared, working.files, t.history.restoreMessage(when));
    setBuffers(result.buffers);
    const open = openPathRef.current;
    const firstText = prepared.find((c) => c.kind === 'text')?.path;
    const target = open && result.buffers[open] ? open : firstText;
    if (target === open) setEditorRev((n) => n + 1);
    else setOpenPath(target);
    setNotice(t.history.restored(changes.length, when));
    onRoute({ name: 'workspace', ...base, path: target });
  };
  const toLastVisit = () => {
    const b = lastVisit.banner;
    if (b) onRoute({ name: 'history', ...base, compare: { base: b.since, head: b.head, since: true } });
  };
  const markSeen = (head: string) => {
    lastVisit.markSeen(head);
    setNotice(t.history.since.marked);
    if (historyRoute?.compare?.since) onRoute({ name: 'history', ...base });
  };

  const reload = async () => {
    if (status.kind !== 'conflict') return;
    const copies = status.copies;
    if (await load()) setStatus({ kind: 'conflict', copies, reloaded: true });
  };

  // Contents and Admin live on this screen; Proposals is App's.
  const navigate = (id: NavId) => {
    if (id === 'admin') return openSettings();
    if (id === 'history') return onRoute({ name: 'history', ...base });
    if (id === 'asks') return onRoute({ name: 'asks', ...base });
    if (id === 'comments' && comments.enabled) {
      if (paneless) toEditor();
      return comments.toggle();
    }
    if (id === 'chat' && chat.enabled) {
      if (paneless) toEditor();
      return chat.toggle();
    }
    if (id === 'contents') {
      if (paneless) toEditor();
      return;
    }
    if (id === 'references') return onRoute({ name: 'references', ...base });
    shell.onNavigate(id);
  };
  const screenShell: ShellContext = { ...shell, admin, onNavigate: navigate, comments: comments.enabled ? { unread: comments.unread } : undefined, chat: chat.enabled ? { unread: chat.unread } : undefined };

  const chooseTab = (tab: ContentsTab) => {
    setContentsTab(tab);
    writeContentsTab(repo.fullName, tab);
  };
  /** A folder in the breadcrumb: show it in the Files tab. */
  const revealFolder = () => {
    chooseTab('files');
    const { state, dispatch } = shell.sidebar;
    if (state.viewport === 'narrow') {
      if (!state.drawerOpen) dispatch({ type: 'toggle' });
    } else dispatch({ type: 'expand' });
  };
  const repoCrumb: Crumb = { label: repo.fullName, onSelect: shell.onRepos, title: t.nav.switchRepo };
  const fileCrumbs = (path: string): (string | Crumb)[] => {
    const folders = labels[path] ? [] : path.split('/').slice(0, -1);
    return [...folders.map((name) => ({ label: name, onSelect: revealFolder, title: t.nav.files })), label(path)];
  };
  const crumbs: (string | Crumb)[] = [
    repoCrumb,
    ...(adminTab ? [t.admin.title, t.admin[adminTab]] : historyRoute ? [t.history.title] : refsRoute ? [t.references.title] : asksRoute ? [t.team.asksTitle] : openPath ? fileCrumbs(openPath) : []),
  ];
  const active: NavId = adminTab ? 'admin' : historyRoute ? 'history' : refsRoute ? 'references' : asksRoute ? 'asks' : 'contents';
  // Admin, History and References replace the editor: no editor actions in the header.
  const away = paneless;
  // Symbol palette and find in files (editing extras).
  const editorView = useRef<EditorView>(undefined);
  const symbols = useSymbolPalette({ enabled: !away, view: () => editorView.current, notify: setNotice });
  const find = useFindReplace({
    enabled: !away && working !== undefined,
    gateway,
    repo,
    working,
    visible,
    buffers: () => buffersRef.current,
    setBuffers,
    onReplaced: (paths) => openPathRef.current && paths.includes(openPathRef.current) && setEditorRev((n) => n + 1),
    onOpenAt: (path, line) => void openAt(path, line),
    notify: setNotice,
  });

  if (loadError) {
    return (
      <AppShell shell={screenShell} active={active} crumbs={[repoCrumb]}>
        <div class="page">
          <div class="notice notice-danger" role="alert">
            <p>{loadError}</p>
            <button type="button" onClick={() => void load()}>
              {t.workspace.tryAgain}
            </button>
          </div>
        </div>
      </AppShell>
    );
  }
  if (!working) {
    return (
      <AppShell shell={screenShell} active={active} crumbs={[repoCrumb]} mainClass="workspace-main">
        <div class="workspace">
          <Skeleton variant="pane" lines={12} label={t.workspace.opening(repo.fullName)} />
        </div>
      </AppShell>
    );
  }

  const open = openPath ? buffers[openPath] : undefined;
  const dismiss = () => setStatus({ kind: 'idle' });
  const coauthorView = admin && viewAs === 'coauthor';
  const unresolved = unresolvedPaths(buffers);
  const upstreamState: UpstreamBannerState | undefined =
    upstreamNote?.kind === 'conflict'
      ? { kind: 'conflict', url: conflictUrl(repo, working.branch) }
      : unresolved.length > 0
        ? { kind: 'choose', files: unresolved }
        : upstream && shouldOffer(upstream, dismissedHead)
          ? { kind: 'behind', behind: upstream.behind, branch: repo.defaultBranch, busy: bringing }
          : undefined;
  const upstreamBanner = upstreamState && (
    <UpstreamBanner
      state={upstreamState}
      onBringIn={() => void bringInNow()}
      onReview={() => unresolved[0] && void openFile(unresolved[0])}
      onDismiss={() => {
        if (upstreamNote) setUpstreamNote(undefined);
        else setDismissedHead(upstream?.defaultHead);
      }}
    />
  );
  const resolveRegions = (path: string, regions: MergeRegion[]) =>
    setBuffers((b) => {
      const buffer = b[path];
      return buffer?.merge ? { ...b, [path]: { ...buffer, merge: { ...buffer.merge, regions } } } : b;
    });
  const applyResolution = (path: string) => {
    const regions = buffersRef.current[path]?.merge?.regions;
    const text = regions && resolvedText(regions);
    if (text === undefined) return;
    setBuffers((b) => {
      const buffer = b[path];
      return buffer ? { ...b, [path]: { base: buffer.base, text } } : b;
    });
    setEditorRev((n) => n + 1);
    announce(t.resolve.applied(path));
  };
  const lastVisitBanner = lastVisit.banner && !historyRoute?.compare?.since && (
    <LastVisitBannerView banner={lastVisit.banner} onSee={toLastVisit} onSeen={() => lastVisit.banner && markSeen(lastVisit.banner.head)} />
  );
  const banner =
    upstreamBanner || lastVisitBanner || coauthorView || (project.kind !== 'valid' && !setupDismissed && adminTab !== 'settings') ? (
      <>
        {upstreamBanner}
        {lastVisitBanner}
        {coauthorView && (
          <div class="line-banner line-banner-info" role="status">
            <Icon name="eye" class="line-banner-icon" />
            <p class="line-banner-text">{t.admin.viewingAs}</p>
            <button type="button" class="line-banner-action" title={t.admin.exitHint} onClick={() => changeViewAs('all')}>
              {t.admin.exit}
            </button>
          </div>
        )}
        <SetupBanner
          admin={admin}
          hidden={adminTab === 'settings'}
          state={project.kind}
          repoName={repo.fullName}
          problems={project.kind === 'missing' ? [] : project.problems}
          dismissed={setupDismissed}
          onSettings={openSettings}
          onDismiss={() => {
            setSetupDismissed(true);
            dismissSetup(repo.fullName);
          }}
        />
      </>
    ) : undefined;

  const userAuto = readPrefs().autoCompile;
  return (
    <AppShell
      shell={screenShell}
      active={active}
      crumbs={crumbs}
      mainClass={away ? undefined : 'workspace-main'}
      focus={focus}
      banner={banner}
      actions={
        <>
          {aids.status}
          {!away && <EditorModeSwitch mode={mode} onMode={changeMode} />}
          {symbols.button}
          {!away && <ViewSwitch view={switchPressed(layout, fits, view, single)} pdf={pdfLayout} onView={(v) => applyView(chooseFromSwitch(layout, fits, v))} />}
          {!away && <ViewMenu layout={layout} focus={focus} onLayout={chooseLayout} onFocus={setFocus} onToggle={toggleView} />}
          {focus && (
            <button type="button" class="focus-exit" aria-label={t.view.exitFocusLong} title={t.view.exitFocusHint} onClick={() => setFocus(false)}>
              <Icon name="close" />
              <span class="focus-exit-long">{t.view.exitFocus}</span>
              <span class="focus-exit-short">{t.view.exitFocusShort}</span>
            </button>
          )}
          {!away && comments.toggleButton}
          <SaveControl
            dirtyCount={dirty.length + authoring.uploads.length + restored.pending.length}
            message={message}
            placeholder={hasDirty ? (authoring.defaultMessage ?? restored.message ?? defaultMessage(dirty, t)) : t.save.describe}
            pending={authoring.pending}
            saving={status.kind === 'saving'}
            noteRequest={noteRequest}
            draftSaved={drafts.saved}
            onMessage={setMessage}
            onSave={() => void save()}
            more={
              <MoreMenu
                items={[
                  ...(away
                    ? []
                    : [
                        { label: t.shell.recompile, kbd: 'Ctrl+Enter', onSelect: () => setRecompileSeq((n) => n + 1) },
                        {
                          label: mode === 'writing' ? t.editor.switchToCode : t.editor.switchToWriting,
                          fold: 'medium' as const,
                          onSelect: () => changeMode(mode === 'writing' ? 'code' : 'writing'),
                        },
                        ...(comments.enabled ? [{ label: t.comments.toggle, fold: 'small' as const, onSelect: comments.toggle }] : []),
                        { label: focus ? t.view.exitFocusLong : t.view.focus, fold: 'tiny' as const, onSelect: () => setFocus(!focus) },
                        ...(draftShare.item ? [draftShare.item] : []),
                        ...(symbols.menuItem ? [symbols.menuItem] : []),
                        ...(find.menuItem ? [find.menuItem] : []),
                      ]),
                  { label: t.save.addNoteMenu, narrowOnly: true, onSelect: () => setNoteRequest((n) => n + 1) },
                ]}
              />
            }
          />
        </>
      }
      contents={
        <Contents
          tab={contentsTab}
          onTab={chooseTab}
          filesHint={admin ? undefined : project.kind === 'valid' ? t.viewNotice.coauthorView : undefined}
          outline={
            <Outline
              main={main}
              openPath={openPath}
              items={outline}
              label={label}
              onOpenFile={(p) => void openFile(p)}
              onHeading={goToHeading}
              structure={authoring.structure}
              team={team.outline}
              words={aids.outlineWords}
            />
          }
          files={
            <>
              {working.truncated && <p class="muted panel-note">{t.files.truncated}</p>}
              <FileTree
                paths={visible}
                openPath={openPath}
                dirty={new Set(dirty)}
                labels={labels}
                onOpen={(p) => void openFile(p)}
                onView={viewFile}
                viewAnyImage={admin && viewAs !== 'coauthor'}
                uploads={authoring.uploadRules}
                pending={authoring.pendingPaths}
                onUpload={authoring.onUpload}
              />
            </>
          }
        />
      }
      toasts={
        <>
          {status.kind !== 'idle' && status.kind !== 'saving' && (
            <Toast
              tone={status.kind === 'saved' ? (status.pullRequestUrl ? 'ok' : 'warn') : 'danger'}
              onDismiss={status.kind === 'conflict' ? undefined : dismiss}
            >
              <StatusBanner status={status} onReload={() => void reload()} onDismiss={dismiss} />
            </Toast>
          )}
          {fileError && (
            <Toast tone="danger" onDismiss={() => setFileError(undefined)}>
              <p role="alert">{fileError}</p>
            </Toast>
          )}
          {drafts.toasts}
          {notice && (
            <Toast onDismiss={() => setNotice(undefined)}>
              <p>{notice}</p>
            </Toast>
          )}
        </>
      }
    >
      {adminTab ? (
        <AdminArea
          admin={admin}
          tab={adminTab}
          onTab={(tab) => onRoute({ name: 'admin', ...base, tab })}
          coauthorView={viewAs === 'coauthor'}
          onCoauthorView={(on) => changeViewAs(on ? 'coauthor' : 'all')}
          coauthorCount={visibleFiles(working.files, project, false).length}
          team={
            shell.team && teamActivity ? (
              <teamActivity.TeamActivity team={shell.team} repo={repo} onAuthRequired={() => onAuthRequired(unsavedChanges(buffersRef.current))} />
            ) : (
              <Skeleton lines={6} label={t.team.activityLoading} />
            )
          }
          panel={
            admin && adminPanels && isPanelTab(adminTab) ? (
              <adminPanels.AdminPanels
                tab={adminTab}
                repoId={repo.id}
                me={shell.user?.login}
                onOpenProposals={(author) => onRoute({ name: 'proposals', ...base, author })}
                onCopyIntoDraft={(path, content) => void copyIntoDraft(path, content)}
                onAuthRequired={() => onAuthRequired(unsavedChanges(buffersRef.current))}
              />
            ) : (
              <Skeleton lines={6} label={t.adminPanel.loading} />
            )
          }
          settings={
            admin && settings ? (
              <settings.ProjectSettings
                gateway={gateway}
                repo={repo}
                working={working}
                project={project}
                onSaved={configSaved}
                onCancel={toEditor}
                onAuthRequired={() => onAuthRequired(unsavedChanges(buffersRef.current))}
              />
            ) : (
              <Skeleton lines={6} label={t.workspace.loadingSettings} />
            )
          }
        />
      ) : asksRoute ? (
        shell.team && asksModule ? (
          <asksModule.MyAsks team={shell.team} repo={repo} me={shell.user?.login} onAuthRequired={() => onAuthRequired(unsavedChanges(buffersRef.current))} />
        ) : (
          <Skeleton lines={6} label={t.team.asksLoading} />
        )
      ) : historyRoute ? (
        history && historyModule ? (
          <historyModule.History
            gateway={gateway}
            history={history}
            repo={repo}
            access={access}
            workingHead={working.headSha}
            dirty={dirty}
            entry={entry}
            compare={historyRoute.compare}
            onRoute={onRoute}
            onRestore={restoreFromHistory}
            onSeen={markSeen}
            onAuthRequired={() => onAuthRequired(unsavedChanges(buffersRef.current))}
          />
        ) : (
          <Skeleton lines={8} label={t.history.loading} />
        )
      ) : refsRoute ? (
        refsModule ? (
          <refsModule.References
            paths={bibPaths}
            texts={Object.fromEntries(bibPaths.map((p) => [p, buffers[p]?.text]))}
            failed={bibFailed}
            selectedKey={refsRoute.key}
            cites={indexState.index?.cites}
            mailto={shell.user?.email}
            label={label}
            onSelect={(key) => onRoute({ name: 'references', ...base, key })}
            onChange={(path, text) => setBuffers((b) => ({ ...b, [path]: { base: b[path]?.base ?? '', text } }))}
            onOpenAt={(path, line) => void openAt(path, line)}
            onNotice={setNotice}
          />
        ) : (
          <Skeleton lines={8} label={t.references.loading} />
        )
      ) : (
        <div
          ref={measureRef}
          class="workspace"
          data-layout={layout}
          data-view={layout === 'editor' ? 'edit' : layout === 'preview' ? 'preview' : view}
          data-single={pdfLayout && single ? 'true' : undefined}
          data-comments={comments.panel || chat.panel ? 'open' : undefined}>
          <section class="editor-pane" aria-label={t.workspace.editorRegion} data-tour="editor">
            {openPath && open?.merge ? (
              <MergeResolver
                path={openPath}
                branch={repo.defaultBranch}
                regions={open.merge.regions}
                onChange={(regions) => resolveRegions(openPath, regions)}
                onApply={() => applyResolution(openPath)}
              />
            ) : openPath && open ? (
              <Editor
                key={`${openPath}#${editorRev}`}
                path={openPath}
                label={t.workspace.editorContents(openPath)}
                doc={open.text}
                jumpTo={editorJump}
                mode={mode}
                vim={prefs.vim === true}
                spellcheck={{ on: prefs.spellcheck !== false, lang: aids.lang }}
                onVimFailed={() => setNotice(t.editor.vimFailed)}
                onSave={() => setNoteRequest((n) => n + 1)}
                assist={assist}
                indexVersion={indexState.version}
                comments={comments.editorComments}
                applyEdit={comments.applyEdit}
                onDropFiles={authoring.onEditorDrop}
                insert={insertReq}
                onView={(v) => (editorView.current = v)}
                onChange={(text) => setBuffers((b) => ({ ...b, [openPath]: { base: b[openPath]?.base ?? '', text } }))}
              />
            ) : (
              <p class="muted pane-empty">{t.workspace.chooseFile}</p>
            )}
            <p class="visually-hidden" aria-live="polite">
              {announcement}
            </p>
          </section>
          <section class="preview-pane" aria-label={pdfLayout ? t.ci.pdfView.region : t.workspace.previewRegion} data-tour="preview">
            {pdfLayout && (
              <CompiledPdfView ci={shell.ci} repo={repo} onAuthRequired={() => onAuthRequired(unsavedChanges(buffersRef.current))} />
            )}
            {/* The live preview stays mounted (and compiled) behind the PDF, so switching back is instant. */}
            <div class="preview-live" hidden={pdfLayout}>
            <Preview
              gateway={authoring.previewGateway}
              repo={repo}
              headSha={working.headSha}
              files={authoring.pendingPaths.size ? [...working.files, ...authoring.pendingPaths] : working.files}
              buffers={buffers}
              entry={entry}
              autoCompileDefault={userAuto ?? (project.kind === 'valid' && project.config.preview.autoCompile)}
              scrollTo={jump}
              recompileSeq={recompileSeq}
              {...comments.preview}
            />
            {comments.previewAction}
            </div>
          </section>
          {comments.panel}
          {chat.panel}
        </div>
      )}
      {authoring.dialogs}
      {symbols.dialog}
      {find.panel}
      {team.dialogs}
      <FigureLightbox path={figure?.path} state={figure?.state ?? { kind: 'loading' }} onClose={() => setFigure(undefined)} />
    </AppShell>
  );
}

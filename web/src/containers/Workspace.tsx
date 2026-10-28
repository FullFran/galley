import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AuthRequiredError, type FileChange, type RepoAccess, type RepoGateway, type Repository, type WorkingState } from '../domain';
import { CONFIG_PATH, visibleFiles, type ProjectConfig } from '../config/project';
import { applySaved, defaultMessage, describeError, dirtyPaths, runSave, unsavedChanges, type Buffers } from '../workspace/model';
import { useT, useTRef } from '../i18n';
import type { AdminTabId } from '../shell/adminTabs';
import type { NavId } from '../shell/nav';
import { dismissSetup, isSetupDismissed, readContentsTab, readPrefs, writeContentsTab, type ContentsTab } from '../shell/prefs';
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
import type { ConfigSaved } from './ProjectSettings';

// The YAML parser, the wizard and the settings form load on demand.
type SettingsModule = typeof import('./ProjectSettings');
const loadSettings = () => import('./ProjectSettings');

export interface WorkspaceProps {
  gateway: RepoGateway;
  repo: Repository;
  /** What the user may do in the repository; admins get project settings. */
  access: (repo: Repository) => Promise<RepoAccess>;
  shell: ShellContext;
  /** Where the URL points inside this repository: a file, or an admin tab. */
  route: Extract<RepoRoute, { name: 'workspace' | 'admin' }>;
  /** Moves to another route (App keeps the URL and the unsaved-changes guard). */
  onRoute: (route: RepoRoute) => void;
  /** Called with the edits that are not saved yet, so they can stay visible. */
  onAuthRequired: (unsaved: FileChange[]) => void;
  onDirtyChange: (dirty: boolean) => void;
  /** A save created or updated a proposal. */
  onSaved?: () => void;
}

type Heading = Extract<OutlineItem, { kind: 'heading' }>;

export function Workspace({ gateway, repo, route, onRoute, access, shell, onAuthRequired, onDirtyChange, onSaved }: WorkspaceProps) {
  const t = useT();
  // Callbacks read the catalog through a ref: a language switch must not
  // re-create `load` (that would reload the repository and drop edits).
  const tRef = useTRef();
  const [working, setWorking] = useState<WorkingState>();
  const [project, setProject] = useState<ProjectConfig>({ kind: 'missing' });
  const [admin, setAdmin] = useState(false);
  const [settings, setSettings] = useState<SettingsModule>();
  const [buffers, setBuffers] = useState<Buffers>({});
  const [openPath, setOpenPath] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [jump, setJump] = useState<{ line: number; id?: string; text: string; seq: number }>();
  // Below 1024px the editor and the preview share one pane.
  const [view, setView] = useState<PaneView>('edit');
  // Admins can look at the paper as co-authors see it.
  const [viewAs, setViewAs] = useState<ViewAs>(() => readViewAs(repo.fullName));
  const [contentsTab, setContentsTab] = useState<ContentsTab>(() => readContentsTab(repo.fullName));
  const [setupDismissed, setSetupDismissed] = useState(() => isSetupDismissed(repo.fullName));
  const [recompileSeq, setRecompileSeq] = useState(0);
  const [noteRequest, setNoteRequest] = useState(0);
  const adminTab: AdminTabId | undefined = route.name === 'admin' ? route.tab : undefined;
  const routePath = route.name === 'workspace' ? route.path : undefined;
  const routePathRef = useRef(routePath);
  routePathRef.current = routePath;
  const base = repoRoute(repo.fullName);
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;

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
  const hasDirty = dirty.length > 0;
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

  const visible = working ? filesInView(working.files, project, admin, viewAs) : [];
  const changeViewAs = (mode: ViewAs) => {
    setViewAs(mode);
    writeViewAs(repo.fullName, mode);
  };
  const labels = project.kind === 'valid' ? project.config.labels : {};
  const label = (path: string) => labels[path] ?? path.slice(path.lastIndexOf('/') + 1);
  const entry = project.kind === 'valid' ? project.config.entry : undefined;
  const main = mainDocument(visible.filter((p) => fileKind(p) !== 'binary'), entry);
  const openText = openPath ? buffers[openPath]?.text : undefined;
  const outline = useMemo(() => (openText === undefined ? [] : extractOutline(openText)), [openText]);

  const showFile = (path: string, follow: boolean) => {
    setOpenPath(path);
    // The URL follows the open file, so a reload comes back to it.
    if (follow && (route.name !== 'workspace' || route.path !== path)) onRoute({ name: 'workspace', ...base, path });
  };

  /** `follow`: put the file in the URL (false when the URL already moved, on back/forward). */
  const openFile = async (path: string, follow = true) => {
    setFileError(undefined);
    shell.sidebar.dispatch({ type: 'navigate' });
    if (path !== openPath) setJump(undefined);
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
    if (adminTab) onRoute({ name: 'workspace', ...base, path: openPath });
    setJump((j) => ({ line: item.line, id: item.id, text: item.title, seq: (j?.seq ?? 0) + 1 }));
  };

  const save = async () => {
    if (!working || !hasDirty || status.kind === 'saving') return;
    setStatus({ kind: 'saving' });
    const outcome = await runSave(gateway, repo, buffers, message.trim() || defaultMessage(dirty, t), working.headSha, t);
    switch (outcome.kind) {
      case 'saved':
        setWorking((w) => w && { ...w, headSha: outcome.headSha, branchExists: true });
        setBuffers((b) => applySaved(b, outcome.saved));
        setMessage('');
        setStatus({ kind: 'saved', pullRequestUrl: outcome.pullRequestUrl });
        onSaved?.();
        break;
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

  const openSettings = () => onRoute({ name: 'admin', ...base, tab: 'settings' });

  const reload = async () => {
    if (status.kind !== 'conflict') return;
    const copies = status.copies;
    if (await load()) setStatus({ kind: 'conflict', copies, reloaded: true });
  };

  // Contents and Admin live on this screen; Proposals is App's.
  const navigate = (id: NavId) => {
    if (id === 'admin') return openSettings();
    if (id === 'contents') {
      if (adminTab) toEditor();
      return;
    }
    shell.onNavigate(id);
  };
  const screenShell: ShellContext = { ...shell, admin, onNavigate: navigate };

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
    ...(adminTab ? [t.admin.title, t.admin[adminTab]] : openPath ? fileCrumbs(openPath) : []),
  ];
  const active: NavId = adminTab ? 'admin' : 'contents';

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
  const banner =
    coauthorView || (project.kind !== 'valid' && !setupDismissed && adminTab !== 'settings') ? (
      <>
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
      mainClass={adminTab ? undefined : 'workspace-main'}
      banner={banner}
      actions={
        <>
          {!adminTab && <ViewSwitch view={view} onView={setView} />}
          <SaveControl
            dirtyCount={dirty.length}
            message={message}
            placeholder={hasDirty ? defaultMessage(dirty, t) : t.save.describe}
            saving={status.kind === 'saving'}
            noteRequest={noteRequest}
            onMessage={setMessage}
            onSave={() => void save()}
            more={
              <MoreMenu
                items={[
                  ...(adminTab ? [] : [{ label: t.shell.recompile, kbd: 'Ctrl+Enter', onSelect: () => setRecompileSeq((n) => n + 1) }]),
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
            />
          }
          files={
            <>
              {working.truncated && <p class="muted panel-note">{t.files.truncated}</p>}
              <FileTree paths={visible} openPath={openPath} dirty={new Set(dirty)} labels={labels} onOpen={(p) => void openFile(p)} />
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
      ) : (
        <div class="workspace" data-view={view}>
          <section class="editor-pane" aria-label={t.workspace.editorRegion} data-tour="editor">
            {openPath && open ? (
              <Editor
                key={openPath}
                path={openPath}
                label={t.workspace.editorContents(openPath)}
                doc={open.text}
                jumpTo={jump}
                onChange={(text) => setBuffers((b) => ({ ...b, [openPath]: { base: b[openPath]?.base ?? '', text } }))}
              />
            ) : (
              <p class="muted pane-empty">{t.workspace.chooseFile}</p>
            )}
          </section>
          <section class="preview-pane" aria-label={t.workspace.previewRegion} data-tour="preview">
            <Preview
              gateway={gateway}
              repo={repo}
              headSha={working.headSha}
              files={working.files}
              buffers={buffers}
              entry={entry}
              autoCompileDefault={userAuto ?? (project.kind === 'valid' && project.config.preview.autoCompile)}
              scrollTo={jump}
              recompileSeq={recompileSeq}
            />
          </section>
        </div>
      )}
    </AppShell>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AuthRequiredError, type FileChange, type RepoAccess, type RepoGateway, type Repository, type WorkingState } from '../domain';
import { CONFIG_PATH, visibleFiles, type ProjectConfig } from '../config/project';
import { applySaved, defaultMessage, describeError, dirtyPaths, runSave, unsavedChanges, type Buffers } from '../workspace/model';
import { useT, useTRef } from '../i18n';
import type { NavId } from '../shell/nav';
import { extractOutline, type OutlineItem } from '../shell/outline';
import { filesInView, readViewAs, writeViewAs, type ViewAs } from '../config/viewAs';
import { mainDocument } from '../workspace/session';
import { fileKind } from '../workspace/tree';
import { Editor } from '../ui/Editor';
import { Preview } from './Preview';
import { FileTree } from '../ui/FileTree';
import { StatusBanner, type SaveStatus } from '../ui/StatusBanner';
import { ViewNotice } from '../ui/config/ViewNotice';
import { AppShell, type ShellContext } from '../ui/shell/AppShell';
import { Outline } from '../ui/shell/Outline';
import { SaveControl } from '../ui/shell/SaveControl';
import { Skeleton } from '../ui/shell/Skeleton';
import { Toast } from '../ui/shell/Toasts';
import { ViewSwitch, type PaneView } from '../ui/shell/ViewSwitch';
import { ViewAsSwitch } from '../ui/shell/ViewAsSwitch';
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
  /** Open project settings right away (chosen in the sidebar on another screen). */
  settingsFirst?: boolean;
  /** Called with the edits that are not saved yet, so they can stay visible. */
  onAuthRequired: (unsaved: FileChange[]) => void;
  onDirtyChange: (dirty: boolean) => void;
  /** A save created or updated a proposal. */
  onSaved?: () => void;
}

type Heading = Extract<OutlineItem, { kind: 'heading' }>;

export function Workspace({ gateway, repo, access, shell, settingsFirst = false, onAuthRequired, onDirtyChange, onSaved }: WorkspaceProps) {
  const t = useT();
  // Callbacks read the catalog through a ref: a language switch must not
  // re-create `load` (that would reload the repository and drop edits).
  const tRef = useTRef();
  const [working, setWorking] = useState<WorkingState>();
  const [project, setProject] = useState<ProjectConfig>({ kind: 'missing' });
  const [admin, setAdmin] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      const target =
        previous && visible.includes(previous)
          ? previous
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

  const openFile = async (path: string) => {
    setFileError(undefined);
    setSettingsOpen(false);
    shell.sidebar.dispatch({ type: 'navigate' });
    if (path !== openPath) setJump(undefined);
    if (!visible.includes(path)) return;
    if (buffers[path] || !working) {
      setOpenPath(path);
      return;
    }
    try {
      const text = await gateway.readFile(repo, path, working.headSha);
      setBuffers((b) => (b[path] ? b : { ...b, [path]: { base: text, text } }));
      setOpenPath(path);
    } catch (err) {
      fail(err, setFileError);
    }
  };

  const goToHeading = (item: Heading) => {
    setSettingsOpen(false);
    shell.sidebar.dispatch({ type: 'navigate' });
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
    setSettingsOpen(false);
    setStatus({ kind: 'saved', pullRequestUrl: saved.pullRequestUrl });
    onSaved?.();
  };

  const openSettings = useCallback(() => {
    setSettingsOpen(true);
    if (!settings) {
      loadSettings().then(setSettings, (err: unknown) => {
        setSettingsOpen(false);
        fail(err, setFileError);
      });
    }
  }, [settings, fail]);

  const wantsSettings = useRef(settingsFirst);
  useEffect(() => {
    if (admin && wantsSettings.current) {
      wantsSettings.current = false;
      openSettings();
    }
  }, [admin, openSettings]);

  const reload = async () => {
    if (status.kind !== 'conflict') return;
    const copies = status.copies;
    if (await load()) setStatus({ kind: 'conflict', copies, reloaded: true });
  };

  // Paper, Files and Settings live on this screen; everything else is App's.
  const navigate = (id: NavId) => {
    if (id === 'settings') return openSettings();
    if (id === 'paper') {
      setSettingsOpen(false);
      return;
    }
    if (id === 'files') return;
    shell.onNavigate(id);
  };
  const screenShell: ShellContext = { ...shell, admin, onNavigate: navigate };
  const crumbs = [repo.fullName, ...(settingsOpen ? [t.nav.settings] : openPath ? [label(openPath)] : [])];

  if (loadError) {
    return (
      <AppShell shell={screenShell} active="paper" crumbs={[repo.fullName]}>
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
      <AppShell shell={screenShell} active="paper" crumbs={[repo.fullName]} mainClass="workspace-main">
        <div class="workspace">
          <Skeleton variant="pane" lines={12} label={t.workspace.opening(repo.fullName)} />
        </div>
      </AppShell>
    );
  }

  const open = openPath ? buffers[openPath] : undefined;
  const dismiss = () => setStatus({ kind: 'idle' });
  return (
    <AppShell
      shell={screenShell}
      active={settingsOpen ? 'settings' : 'paper'}
      crumbs={crumbs}
      mainClass="workspace-main"
      actions={
        <>
          <ViewSwitch view={view} onView={setView} />
          <SaveControl
            dirtyCount={dirty.length}
            message={message}
            placeholder={hasDirty ? defaultMessage(dirty, t) : t.save.describe}
            saving={status.kind === 'saving'}
            onMessage={setMessage}
            onSave={() => void save()}
          />
        </>
      }
      panels={{
        paper: (
          <Outline
            main={main}
            openPath={openPath}
            items={outline}
            label={label}
            onOpenFile={(p) => void openFile(p)}
            onHeading={goToHeading}
          />
        ),
        files: (
          <>
            {admin && <ViewAsSwitch mode={viewAs} onMode={changeViewAs} />}
            <ViewNotice
              admin={admin}
              state={project.kind}
              repoName={repo.fullName}
              visibleCount={visibleFiles(working.files, project, false).length}
              problems={project.kind === 'missing' ? [] : project.problems}
              onSettings={openSettings}
            />
            {working.truncated && <p class="muted panel-note">{t.workspace.truncated}</p>}
            <FileTree paths={visible} openPath={openPath} dirty={new Set(dirty)} labels={labels} onOpen={(p) => void openFile(p)} />
          </>
        ),
      }}
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
      <div class="workspace" data-view={view}>
        <section class="editor-pane" aria-label={t.workspace.editorRegion} data-tour="editor">
          {settingsOpen && admin && settings ? (
            <div class="pane-scroll">
              <settings.ProjectSettings
                gateway={gateway}
                repo={repo}
                working={working}
                project={project}
                onSaved={configSaved}
                onCancel={() => setSettingsOpen(false)}
                onAuthRequired={() => onAuthRequired(unsavedChanges(buffersRef.current))}
              />
            </div>
          ) : settingsOpen && admin ? (
            <Skeleton lines={6} label={t.workspace.loadingSettings} />
          ) : openPath && open ? (
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
            autoCompileDefault={project.kind === 'valid' && project.config.preview.autoCompile}
            scrollTo={jump}
          />
        </section>
      </div>
    </AppShell>
  );
}

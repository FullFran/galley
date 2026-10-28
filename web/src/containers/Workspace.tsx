import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AuthRequiredError, type FileChange, type RepoAccess, type RepoGateway, type Repository, type WorkingState } from '../domain';
import { CONFIG_PATH, visibleFiles, type ProjectConfig } from '../config/project';
import { applySaved, defaultMessage, describeError, dirtyPaths, runSave, unsavedChanges, type Buffers } from '../workspace/model';
import { Editor } from '../ui/Editor';
import { Preview } from './Preview';
import { FileTree } from '../ui/FileTree';
import { SaveBar } from '../ui/SaveBar';
import { StatusBanner, type SaveStatus } from '../ui/StatusBanner';
import { ViewNotice } from '../ui/config/ViewNotice';
import type { ConfigSaved } from './ProjectSettings';

// The YAML parser, the wizard and the settings form load on demand.
type SettingsModule = typeof import('./ProjectSettings');
const loadSettings = () => import('./ProjectSettings');

export interface WorkspaceProps {
  gateway: RepoGateway;
  repo: Repository;
  /** What the user may do in the repository; admins get project settings. */
  access: (repo: Repository) => Promise<RepoAccess>;
  /** Called with the edits that are not saved yet, so they can stay visible. */
  onAuthRequired: (unsaved: FileChange[]) => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function Workspace({ gateway, repo, access, onAuthRequired, onDirtyChange }: WorkspaceProps) {
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
  // On narrow screens the editor and the preview share one column.
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;

  const fail = useCallback(
    (err: unknown, show: (message: string) => void) => {
      if (err instanceof AuthRequiredError) onAuthRequired(unsavedChanges(buffersRef.current));
      else show(describeError(err));
    },
    [onAuthRequired],
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

  const visible = working ? visibleFiles(working.files, project, admin) : [];

  const openFile = async (path: string) => {
    setFileError(undefined);
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

  const save = async () => {
    if (!working || !hasDirty || status.kind === 'saving') return;
    setStatus({ kind: 'saving' });
    const outcome = await runSave(gateway, repo, buffers, message.trim() || defaultMessage(dirty), working.headSha);
    switch (outcome.kind) {
      case 'saved':
        setWorking((w) => w && { ...w, headSha: outcome.headSha, branchExists: true });
        setBuffers((b) => applySaved(b, outcome.saved));
        setMessage('');
        setStatus({ kind: 'saved', pullRequestUrl: outcome.pullRequestUrl });
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
  };

  const openSettings = () => {
    setSettingsOpen(true);
    if (!settings) {
      loadSettings().then(setSettings, (err: unknown) => {
        setSettingsOpen(false);
        fail(err, setFileError);
      });
    }
  };

  const reload = async () => {
    if (status.kind !== 'conflict') return;
    const copies = status.copies;
    if (await load()) setStatus({ kind: 'conflict', copies, reloaded: true });
  };

  if (loadError) {
    return (
      <main class="page">
        <p class="banner banner-error" role="alert">
          {loadError}{' '}
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      </main>
    );
  }
  if (!working) return <main class="page muted">Opening {repo.fullName}…</main>;

  const open = openPath ? buffers[openPath] : undefined;
  return (
    <main class="workspace" data-view={view}>
      <aside>
        <ViewNotice
          admin={admin}
          state={project.kind}
          repoName={repo.fullName}
          visibleCount={visibleFiles(working.files, project, false).length}
          problems={project.kind === 'missing' ? [] : project.problems}
          onSettings={openSettings}
        />
        {working.truncated && <p class="muted">Some files are not listed because the repository is very large.</p>}
        <FileTree paths={visible} openPath={openPath} dirty={new Set(dirty)} onOpen={(p) => void openFile(p)} />
      </aside>
      <section class="editor-pane">
        <button type="button" class="view-toggle" onClick={() => setView('preview')}>
          Show preview
        </button>
        <StatusBanner status={status} onReload={() => void reload()} onDismiss={() => setStatus({ kind: 'idle' })} />
        {fileError && (
          <p class="banner banner-error" role="alert">
            {fileError}
          </p>
        )}
        <SaveBar
          dirtyCount={dirty.length}
          message={message}
          placeholder={hasDirty ? defaultMessage(dirty) : "Describe your changes"}
          saving={status.kind === 'saving'}
          onMessage={setMessage}
          onSave={() => void save()}
        />
        {settingsOpen && admin && settings ? (
          <settings.ProjectSettings
            gateway={gateway}
            repo={repo}
            working={working}
            project={project}
            onSaved={configSaved}
            onCancel={() => setSettingsOpen(false)}
            onAuthRequired={() => onAuthRequired(unsavedChanges(buffersRef.current))}
          />
        ) : settingsOpen && admin ? (
          <p class="muted">Loading project settings…</p>
        ) : openPath && open ? (
          <Editor
            key={openPath}
            path={openPath}
            doc={open.text}
            onChange={(text) => setBuffers((b) => ({ ...b, [openPath]: { base: b[openPath]?.base ?? '', text } }))}
          />
        ) : (
          <p class="muted">Choose a file to edit.</p>
        )}
      </section>
      <section class="preview-pane" aria-label="Preview">
        <button type="button" class="view-toggle" onClick={() => setView('edit')}>
          Show editor
        </button>
        <Preview
          gateway={gateway}
          repo={repo}
          headSha={working.headSha}
          files={working.files}
          buffers={buffers}
          entry={project.kind === 'valid' ? project.config.entry : undefined}
          autoCompileDefault={project.kind === 'valid' && project.config.preview.autoCompile}
        />
      </section>
    </main>
  );
}

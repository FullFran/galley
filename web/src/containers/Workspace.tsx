import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { AuthRequiredError, type FileChange, type RepoGateway, type Repository, type WorkingState } from '../domain';
import { applySaved, defaultMessage, describeError, dirtyPaths, runSave, unsavedChanges, type Buffers } from '../workspace/model';
import { Editor } from '../ui/Editor';
import { FileTree } from '../ui/FileTree';
import { SaveBar } from '../ui/SaveBar';
import { StatusBanner, type SaveStatus } from '../ui/StatusBanner';

export interface WorkspaceProps {
  gateway: RepoGateway;
  repo: Repository;
  /** Called with the edits that are not saved yet, so they can stay visible. */
  onAuthRequired: (unsaved: FileChange[]) => void;
  onDirtyChange: (dirty: boolean) => void;
}

export function Workspace({ gateway, repo, onAuthRequired, onDirtyChange }: WorkspaceProps) {
  const [working, setWorking] = useState<WorkingState>();
  const [buffers, setBuffers] = useState<Buffers>({});
  const [openPath, setOpenPath] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' });
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
      setBuffers({});
      setOpenPath(undefined);
      setWorking(state);
      return true;
    } catch (err) {
      fail(err, setLoadError);
      return false;
    }
  }, [gateway, repo, fail]);

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

  const openFile = async (path: string) => {
    setFileError(undefined);
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
    <main class="workspace">
      <aside>
        {working.truncated && <p class="muted">Some files are not listed because the repository is very large.</p>}
        <FileTree paths={working.files} openPath={openPath} dirty={new Set(dirty)} onOpen={(p) => void openFile(p)} />
      </aside>
      <section class="editor-pane">
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
        {openPath && open ? (
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
    </main>
  );
}

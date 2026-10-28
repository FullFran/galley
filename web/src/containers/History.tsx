import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { AuthRequiredError, NotTextError, type ChangedFile, type RepoAccess, type RepoGateway, type Repository } from '../domain';
import { zipUrl, type Comparison, type HistoryGateway } from '../github/history';
import { fileRestoreOps, planRestore, type RestoreChange, type RestoreOp } from '../history/restore';
import { shortSha, tagNameProblem, withLabels, type Label, type Version } from '../history/versions';
import type { RepoRoute } from '../shell/route';
import { bytesToBase64 } from '../uploads/upload';
import { describeError } from '../workspace/model';
import { fileKind } from '../workspace/tree';
import { useT, useTRef, type Messages } from '../i18n';
import { formatDay, formatUpdated } from '../i18n/format';
import { FileDiff } from '../ui/review/FileDiff';
import { Skeleton } from '../ui/shell/Skeleton';
import { Preview } from './Preview';

// The History screen (loaded on demand): versions of the default branch,
// labels, comparisons, a read-only preview of an old version, the zip, and
// restoring files as unsaved changes in the person's own copy.

export interface HistoryProps {
  gateway: RepoGateway;
  history: HistoryGateway;
  repo: Repository;
  access: (repo: Repository) => Promise<RepoAccess>;
  /** The working head restored changes are based on. */
  workingHead: string;
  /** Files with unsaved edits (restoring the whole paper resets them too). */
  dirty: string[];
  entry?: string;
  compare?: { base: string; head: string; since: boolean };
  onRoute: (route: RepoRoute) => void;
  /** Puts restored files into the working buffers; never saves. */
  onRestore: (changes: RestoreChange[], when: string) => Promise<void>;
  onSeen: (head: string) => void;
  onAuthRequired: () => void;
}

const NO_BUFFERS = {};
const READS_AT_ONCE = 6;

/** The version's files as restore changes (text, bytes, or deletions). */
async function readChanges(gateway: RepoGateway, repo: Repository, sha: string, ops: RestoreOp[]): Promise<RestoreChange[]> {
  const readOne = async (op: RestoreOp): Promise<RestoreChange> => {
    if (op.op === 'delete') return { path: op.path, kind: 'delete' };
    const bytes = async (): Promise<RestoreChange> => ({ path: op.path, kind: 'bytes', base64: bytesToBase64(await gateway.readBytes(repo, op.path, sha)) });
    if (fileKind(op.path) === 'binary') return bytes();
    try {
      return { path: op.path, kind: 'text', text: await gateway.readFile(repo, op.path, sha) };
    } catch (err) {
      if (err instanceof NotTextError) return bytes();
      throw err;
    }
  };
  const out: RestoreChange[] = [];
  for (let i = 0; i < ops.length; i += READS_AT_ONCE) out.push(...(await Promise.all(ops.slice(i, i + READS_AT_ONCE).map(readOne))));
  return out;
}

function versionTitle(v: Version, t: Messages): string {
  if (!v.proposal) return v.title;
  const merged = t.history.proposalMerged(v.proposal.number);
  return v.proposal.title ? `${merged} · ${v.proposal.title}` : merged;
}

export function History(props: HistoryProps) {
  const { gateway, history, repo, access, compare, onRoute } = props;
  const t = useT();
  const m = t.history;
  const tRef = useTRef();
  const base = { owner: repo.owner, repo: repo.name };
  const [versions, setVersions] = useState<Version[]>();
  const [page, setPage] = useState(1);
  const [more, setMore] = useState(false);
  const [labels, setLabels] = useState<Label[]>([]);
  const [selected, setSelected] = useState<string>();
  const [other, setOther] = useState('');
  const [previewing, setPreviewing] = useState<{ sha: string; files: string[] }>();
  const [labelDraft, setLabelDraft] = useState('');
  const [labelError, setLabelError] = useState<string>();
  const [canPush, setCanPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [comparison, setComparison] = useState<Comparison>();

  const fail = useCallback(
    (err: unknown) => (err instanceof AuthRequiredError ? props.onAuthRequired() : setError(describeError(err, tRef.current))),
    [props.onAuthRequired, tRef],
  );

  const loadPage = useCallback(
    async (n: number) => {
      try {
        const res = await history.versions(repo, n);
        setVersions((list) => (n === 1 ? res.versions : [...(list ?? []), ...res.versions]));
        setMore(res.more);
        setPage(n);
      } catch (err) {
        fail(err);
      }
    },
    [history, repo, fail],
  );
  const loadLabels = useCallback(() => history.labels(repo).then(setLabels, fail), [history, repo, fail]);

  useEffect(() => {
    void loadPage(1);
    void loadLabels();
    access(repo).then(
      (a) => setCanPush(a.canPush),
      () => setCanPush(false),
    );
  }, [loadPage, loadLabels, access, repo]);

  useEffect(() => {
    setComparison(undefined);
    if (!compare) return;
    let active = true;
    history.compare(repo, compare.base, compare.head).then((c) => active && setComparison(c), fail);
    return () => {
      active = false;
    };
  }, [history, repo, compare?.base, compare?.head, fail]);

  const list = useMemo(() => (versions ? withLabels(versions, labels) : undefined), [versions, labels]);
  const current = list?.[0];
  const chosen = list?.find((v) => v.sha === selected) ?? current;
  const byShaDay = (sha: string) => {
    const v = list?.find((x) => x.sha === sha || x.sha.startsWith(sha));
    return v ? formatDay(v.date, t.meta.lang) : shortSha(sha);
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await work();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const compareWith = (a: Version, b: Version) => {
    // The older version is the base: the diff reads forward in time.
    const ia = list?.indexOf(a) ?? 0;
    const ib = list?.indexOf(b) ?? 0;
    const [older, newer] = ia > ib ? [a, b] : [b, a];
    onRoute({ name: 'history', ...base, compare: { base: older.sha, head: newer.sha, since: false } });
  };

  const restoreAll = (v: Version) =>
    run(async () => {
      if (!window.confirm(m.confirmRestoreAll)) return;
      const [old, head] = await Promise.all([history.tree(repo, v.sha), history.tree(repo, props.workingHead)]);
      if (old.truncated || head.truncated) return setError(m.restoreTooBig);
      const ops = planRestore(old.blobs, head.blobs, props.dirty);
      if (ops.length === 0) return setNotice(m.restoreNothing);
      await props.onRestore(await readChanges(gateway, repo, v.sha, ops), formatDay(v.date, t.meta.lang));
    });

  const restoreFile = (file: ChangedFile) =>
    run(async () => {
      if (!compare) return;
      await props.onRestore(await readChanges(gateway, repo, compare.base, fileRestoreOps(file)), byShaDay(compare.base));
    });

  const preview = (v: Version) =>
    run(async () => {
      const tree = await history.tree(repo, v.sha);
      setPreviewing({ sha: v.sha, files: Object.keys(tree.blobs).sort() });
    });

  const addLabel = (v: Version) => {
    const name = labelDraft.trim();
    const problem = tagNameProblem(name, labels.map((l) => l.name));
    if (problem) return setLabelError(m.labelProblem[problem]);
    setLabelError(undefined);
    void run(async () => {
      try {
        await history.addLabel(repo, name, v.sha);
      } catch (err) {
        if (err instanceof AuthRequiredError) throw err;
        return setLabelError(m.labelFailed);
      }
      setLabelDraft('');
      await loadLabels();
    });
  };

  const removeLabel = (name: string) =>
    run(async () => {
      if (!window.confirm(m.confirmRemove(name))) return;
      try {
        await history.removeLabel(repo, name);
      } catch (err) {
        if (err instanceof AuthRequiredError) throw err;
        return setLabelError(m.labelFailed);
      }
      await loadLabels();
    });

  const messages = (
    <>
      {error && (
        <p class="notice notice-danger" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p class="notice" role="status">
          {notice}
        </p>
      )}
    </>
  );
  const back = (
    <button type="button" class="link-button" onClick={() => (previewing ? setPreviewing(undefined) : onRoute({ name: 'history', ...base }))}>
      ← {m.back}
    </button>
  );

  if (previewing) {
    const v = list?.find((x) => x.sha === previewing.sha);
    return (
      <div class="history history-preview" data-testid="history-preview">
        <div class="history-bar">
          {back}
          <p class="muted">{m.previewOf(v ? formatDay(v.date, t.meta.lang) : shortSha(previewing.sha))}</p>
        </div>
        <section class="preview-pane history-preview-pane" aria-label={m.preview}>
          <Preview gateway={gateway} repo={repo} headSha={previewing.sha} files={previewing.files} buffers={NO_BUFFERS} entry={props.entry} autoCompileDefault />
        </section>
      </div>
    );
  }

  if (compare) {
    return (
      <div class="page page-wide history" data-testid="history-compare">
        {back}
        <h1>{compare.since ? m.since.title : m.changesBetween(byShaDay(compare.base), byShaDay(compare.head))}</h1>
        {messages}
        {!comparison ? (
          !error && <Skeleton lines={6} label={m.loading} />
        ) : (
          <>
            <p class="muted">{comparison.files.length === 0 ? m.noChanges : m.summary(comparison.files.length, comparison.commits)}</p>
            {comparison.truncated && <p class="muted">{m.truncated}</p>}
            {compare.since ? (
              <p>
                <button type="button" class="primary" onClick={() => props.onSeen(compare.head)}>
                  {m.since.seen}
                </button>
              </p>
            ) : (
              comparison.files.length > 0 && <p class="muted">{m.restoreHint}</p>
            )}
            {comparison.files.map((file) => (
              <div key={file.path} class="history-file">
                {!compare.since && (
                  <div class="history-file-actions">
                    <button type="button" disabled={busy} onClick={() => void restoreFile(file)}>
                      {busy ? m.restoring : m.restoreFile}
                    </button>
                  </div>
                )}
                <FileDiff
                  file={file}
                  threads={[]}
                  replyDrafts={{}}
                  canApply={false}
                  busy={false}
                  readOnly
                  onStartComment={noop}
                  onComposer={noop}
                  onSendComment={noop}
                  onQueueComment={noop}
                  onCancelComment={noop}
                  onSuggest={noop}
                  onReplyDraft={noop}
                  onReply={noop}
                  onApply={noop}
                />
              </div>
            ))}
          </>
        )}
      </div>
    );
  }

  return (
    <div class="page page-wide history" data-testid="history">
      <h1>{m.title}</h1>
      <p class="muted">{m.intro(repo.defaultBranch)}</p>
      {messages}
      {!list ? (
        !error && <Skeleton lines={8} label={m.loading} />
      ) : list.length === 0 ? (
        <p class="muted">{m.empty}</p>
      ) : (
        <div class="history-columns">
          <section aria-label={m.versionList}>
            <ol class="history-list">
              {list.map((v, i) => (
                <li key={v.sha}>
                  <button
                    type="button"
                    class={`history-row${chosen?.sha === v.sha ? ' history-row-selected' : ''}`}
                    aria-pressed={chosen?.sha === v.sha}
                    aria-label={m.select(versionTitle(v, t))}
                    onClick={() => {
                      setSelected(v.sha);
                      setOther('');
                      setLabelError(undefined);
                    }}
                  >
                    <span class="history-row-title">
                      {i === 0 && <span class="chip chip-ok">{m.current}</span>}
                      {v.labels.map((l) => (
                        <span key={l} class="chip history-label">
                          {l}
                        </span>
                      ))}
                      <span>{versionTitle(v, t)}</span>
                    </span>
                    <span class="muted history-row-meta">
                      {m.by(v.author ?? m.someone)} · {formatUpdated(v.date, t.meta.lang)} · <code>{shortSha(v.sha)}</code>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            {more && (
              <button type="button" onClick={() => void loadPage(page + 1)}>
                {m.loadMore}
              </button>
            )}
          </section>
          {chosen && (
            <aside class="history-detail" aria-label={m.actions}>
              <h2>{versionTitle(chosen, t)}</h2>
              <p class="muted">
                {m.by(chosen.author ?? m.someone)} · {formatDay(chosen.date, t.meta.lang)} · <code>{shortSha(chosen.sha)}</code>
              </p>
              <div class="history-actions">
                {current && chosen.sha !== current.sha && (
                  <button type="button" class="primary" onClick={() => compareWith(chosen, current)}>
                    {m.compareCurrent}
                  </button>
                )}
                <button type="button" disabled={busy} onClick={() => void preview(chosen)}>
                  {m.preview}
                </button>
                <a class="button" href={zipUrl(repo, chosen.sha)} target="_blank" rel="noopener noreferrer">
                  {m.zip}
                </a>
                {chosen.htmlUrl && (
                  <a class="button" href={chosen.htmlUrl} target="_blank" rel="noopener noreferrer">
                    {m.viewOnGitHub}
                  </a>
                )}
              </div>
              <p class="muted history-note">{m.zipNote}</p>
              <label class="history-other">
                {m.compareWith}
                <span class="history-inline">
                  <select value={other} onChange={(e) => setOther((e.target as HTMLSelectElement).value)}>
                    <option value="">{m.chooseVersion}</option>
                    {list
                      .filter((v) => v.sha !== chosen.sha)
                      .map((v) => (
                        <option key={v.sha} value={v.sha}>
                          {formatDay(v.date, t.meta.lang)} · {versionTitle(v, t)}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    disabled={!other}
                    onClick={() => {
                      const target = list.find((v) => v.sha === other);
                      if (target) compareWith(chosen, target);
                    }}
                  >
                    {m.compare}
                  </button>
                </span>
              </label>
              <h3>{m.labels}</h3>
              {chosen.labels.length === 0 ? (
                <p class="muted">{m.noLabels}</p>
              ) : (
                <ul class="history-labels">
                  {chosen.labels.map((l) => (
                    <li key={l}>
                      <span class="chip history-label">{l}</span>
                      {canPush && (
                        <button type="button" class="link-button" disabled={busy} aria-label={m.removeLabel(l)} onClick={() => void removeLabel(l)}>
                          ×
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canPush ? (
                <form
                  class="history-inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addLabel(chosen);
                  }}
                >
                  <input
                    type="text"
                    aria-label={m.labelName}
                    placeholder={m.labelPlaceholder}
                    value={labelDraft}
                    maxLength={100}
                    onInput={(e) => setLabelDraft((e.target as HTMLInputElement).value)}
                  />
                  <button type="submit" disabled={busy}>
                    {m.addLabel}
                  </button>
                </form>
              ) : (
                <p class="muted">{m.labelsOnlyPush}</p>
              )}
              {labelError && (
                <p class="notice notice-danger" role="alert">
                  {labelError}
                </p>
              )}
              {current && chosen.sha !== current.sha && (
                <>
                  <h3>{m.restoreAll}</h3>
                  <p class="muted">{m.restoreHint}</p>
                  <button type="button" disabled={busy} onClick={() => void restoreAll(chosen)}>
                    {busy ? m.restoring : m.restoreAll}
                  </button>
                </>
              )}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function noop() {
  return undefined;
}

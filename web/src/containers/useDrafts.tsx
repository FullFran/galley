import { useEffect, useRef, useState } from 'preact/hooks';
import type { RepoGateway, Repository, WorkingState } from '../domain';
import type { DraftMeta, DraftsGateway, ServerDraft } from '../drafts/http';
import { planRestore, restoreBuffer } from '../drafts/restore';
import { draftStore } from '../drafts/store';
import { registerSync } from '../drafts/signout';
import { bufferChanges, createDraftSync, deviceLabel, type DraftSync, type DraftSyncState } from '../drafts/sync';
import { useTRef } from '../i18n';
import { formatDateTime, formatUpdated } from '../i18n/format';
import { onPrefsChange, readPrefs } from '../shell/prefs';
import { Toast } from '../ui/shell/Toasts';
import type { Buffer, Buffers } from '../workspace/model';
import { fileKind } from '../workspace/tree';

// Drafts in the workspace: every edited buffer is kept locally (and on the
// server unless the person turned that off), restored when the repository
// opens again, and deleted once its file is saved for review. Workspace
// passes its buffers in and shows what this returns.

export interface UseDraftsOptions {
  gateway?: DraftsGateway;
  repos: RepoGateway;
  repo: Repository;
  /** The signed-in login; drafts are kept per person. */
  user?: string;
  working?: WorkingState;
  /** Files the person can open here. */
  visible: string[];
  buffers: Buffers;
  setBuffers: (update: (b: Buffers) => Buffers) => void;
  label: (path: string) => string;
  /** The text of an open file was replaced (remount the editor). */
  onReplaced: (path: string) => void;
}

const serverOn = () => readPrefs().serverDrafts !== false;

const NOTICE_MS = 15_000;

type Restored = { paths: string[]; at: number; choose: string[] };

export function useDrafts(o: UseDraftsOptions) {
  const tRef = useTRef();
  const opts = useRef(o);
  opts.current = o;
  const { gateway, repo, user } = o;
  const loaded = o.working !== undefined;
  const [sync, setSync] = useState<DraftSync>();
  const [state, setState] = useState<DraftSyncState>({ writing: false, conflicts: [] });
  const [restored, setRestored] = useState<Restored>();
  const [offer, setOffer] = useState<DraftMeta[]>([]);
  const [failed, setFailed] = useState(false);
  const tracked = useRef(new Set<string>());

  useEffect(() => {
    if (!user) return;
    const s = createDraftSync({
      store: draftStore(),
      gateway,
      user,
      repoId: repo.id,
      device: deviceLabel(globalThis.navigator?.userAgent ?? ''),
      server: serverOn,
      onState: setState,
    });
    setSync(s);
    const unregister = registerSync(s);
    tracked.current = new Set();
    let wasOn = serverOn();
    const offPrefs = onPrefsChange((p) => {
      const on = p.serverDrafts !== false;
      if (on === wasOn) return;
      wasOn = on;
      if (on) s.enableServer();
      else {
        setOffer([]);
        void s.disableServer();
      }
    });
    const flush = () => s.flush();
    const onHidden = () => document.visibilityState === 'hidden' && s.flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      unregister();
      offPrefs();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      s.dispose();
    };
  }, [gateway, repo.id, user]);

  /** Reads `path` at the working head: the open buffer's base, else the repository. */
  const currentText = async (path: string): Promise<{ text: string; headSha: string } | undefined> => {
    const { working, buffers, repos } = opts.current;
    if (!working) return undefined;
    const open = buffers[path];
    if (open) return { text: open.base, headSha: working.headSha };
    return { text: await repos.readFile(repo, path, working.headSha), headSha: working.headSha };
  };

  /** Restores one draft into the buffers; the kind of restore, or undefined when nothing was restored. */
  const restoreOne = async (draft: { path: string; content: string; baseSha: string }) => {
    const current = await currentText(draft.path);
    if (!current) return undefined;
    const outcome = await restoreBuffer(draft, current, (sha) => opts.current.repos.readFile(repo, draft.path, sha));
    if (outcome.kind === 'none') return 'none' as const;
    // Never over edits made meanwhile in this tab.
    const edited = (b: Buffers) => {
      const now = b[draft.path];
      return now !== undefined && (now.text !== now.base || now.merge !== undefined);
    };
    if (edited(opts.current.buffers)) return undefined;
    opts.current.setBuffers((b) => (edited(b) ? b : { ...b, [draft.path]: outcome.buffer }));
    opts.current.onReplaced(draft.path);
    return outcome.kind;
  };

  const restorable = (path: string) => {
    const { working, visible } = opts.current;
    return working !== undefined && working.files.includes(path) && visible.includes(path) && fileKind(path) !== 'binary';
  };

  // On open: bring this browser's drafts back, and offer the ones from other devices.
  useEffect(() => {
    if (!sync || !loaded) return;
    let alive = true;
    void (async () => {
      const local = await sync.load();
      const server = gateway && serverOn() ? await gateway.list(repo.id).catch(() => []) : [];
      if (!alive) return;
      const plan = planRestore(local, server);
      const paths: string[] = [];
      const choose: string[] = [];
      let at = 0;
      for (const d of plan.local) {
        if (!restorable(d.path)) continue;
        const kind = await restoreOne(d).catch(() => undefined);
        if (!alive) return;
        if (kind === 'none') await sync.discard(d.path);
        else if (kind) {
          paths.push(d.path);
          at = Math.max(at, d.updatedAt);
          if (kind === 'conflict') choose.push(d.path);
        }
      }
      for (const c of plan.conflicts) if (restorable(c.path)) sync.markConflict(c.path, c.current);
      setOffer(plan.offer.filter((m) => restorable(m.path)));
      if (paths.length) setRestored({ paths, at, choose });
    })();
    return () => {
      alive = false;
    };
  }, [sync, loaded, gateway, repo.id]);

  // Every buffer change: draft the edited files, drop the drafts of saved ones.
  const headSha = o.working?.headSha;
  useEffect(() => {
    if (!sync || !headSha) return;
    const { edits, clears } = bufferChanges(tracked.current, o.buffers);
    for (const e of edits) sync.edit(e.path, e.text, headSha);
    for (const path of clears) void sync.discard(path);
  }, [sync, o.buffers, headSha]);

  // The restore notice is a hint, not a question: it goes away by itself.
  useEffect(() => {
    if (!restored || restored.choose.length) return;
    const timer = setTimeout(() => setRestored(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [restored]);

  const undoRestore = () => {
    const r = restored;
    setRestored(undefined);
    if (!r || !sync) return;
    opts.current.setBuffers((b) => {
      const next = { ...b };
      for (const p of r.paths) {
        const buf: Buffer | undefined = next[p];
        if (buf) next[p] = { base: buf.base, text: buf.base };
      }
      return next;
    });
    for (const p of r.paths) {
      void sync.discard(p);
      opts.current.onReplaced(p);
    }
  };

  const takeTheirs = async (path: string) => {
    if (!sync) return;
    const d = await sync.useTheirs(path);
    if (!d) return setFailed(true);
    // Their copy replaces this tab's buffer only by the person's choice.
    const current = await currentText(path).catch(() => undefined);
    if (!current) return setFailed(true);
    const outcome = await restoreBuffer(d, current, (sha) => opts.current.repos.readFile(repo, path, sha));
    const buffer = outcome.kind === 'none' ? { base: current.text, text: current.text } : outcome.buffer;
    opts.current.setBuffers((b) => ({ ...b, [path]: buffer }));
    opts.current.onReplaced(path);
  };

  const restoreOffer = async () => {
    const list = offer;
    setOffer([]);
    if (!sync || !gateway) return;
    let bad = false;
    for (const m of list) {
      try {
        const d: ServerDraft = await gateway.get(repo.id, m.path);
        sync.adopt(d);
        const kind = await restoreOne(d);
        if (kind === undefined) bad = true;
      } catch {
        bad = true;
      }
    }
    if (bad) setFailed(true);
  };

  const t = tRef.current;
  const m = t.drafts;
  const lang = t.meta.lang;
  const conflict = state.conflicts[0];
  const toasts = (
    <>
      {restored && (
        <Toast onDismiss={() => setRestored(undefined)}>
          <p role="status">
            {m.restored(formatDateTime(new Date(restored.at).toISOString(), lang))}
            {restored.choose.length > 0 && ` ${m.restoredChoose(restored.choose.map(o.label).join(', '))}`}
          </p>
          <div class="actions">
            <button type="button" onClick={undoRestore}>
              {m.undo}
            </button>
          </div>
        </Toast>
      )}
      {conflict && (
        <Toast tone="warn">
          <p role="alert">
            {conflict.current
              ? m.newer(o.label(conflict.path), conflict.current.device ?? m.anotherDevice, formatUpdated(conflict.current.updatedAt, lang))
              : m.deletedElsewhere(o.label(conflict.path))}
          </p>
          <div class="actions">
            {conflict.current && (
              <button type="button" class="primary" onClick={() => void takeTheirs(conflict.path)}>
                {m.useIt}
              </button>
            )}
            <button type="button" onClick={() => void sync?.keepMine(conflict.path)}>
              {m.keepMine}
            </button>
          </div>
        </Toast>
      )}
      {offer.length > 0 && (
        <Toast onDismiss={() => setOffer([])}>
          <p>{m.offer(offer.length)}</p>
          <ul class="draft-offer">
            {offer.map((d) => (
              <li key={d.path} title={d.path}>
                {m.offerItem(o.label(d.path), d.device ?? m.anotherDevice, formatUpdated(d.updatedAt, lang))}
              </li>
            ))}
          </ul>
          <div class="actions">
            <button type="button" class="primary" onClick={() => void restoreOffer()}>
              {m.restore}
            </button>
            <button type="button" onClick={() => setOffer([])}>
              {m.notNow}
            </button>
          </div>
        </Toast>
      )}
      {failed && (
        <Toast tone="danger" onDismiss={() => setFailed(false)}>
          <p role="alert">{m.restoreFailed}</p>
        </Toast>
      )}
    </>
  );

  return {
    /** The unsaved files are kept as a draft right now. */
    saved: state.savedAt !== undefined && !state.writing,
    toasts,
  };
}

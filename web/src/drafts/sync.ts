import { AuthRequiredError } from '../domain';
import type { Buffers } from '../workspace/model';
import { DraftConflictError, type DraftMeta, type DraftsGateway, type ServerDraft } from './http';
import type { DraftStore, LocalDraft } from './store';

// Keeps drafts of the edited buffers: a local copy about a second after
// typing stops, and (when the person keeps drafts on the server) a server
// copy about five seconds after that, only when the text changed. A server
// copy is replaced only against the version this device last saw; when
// another device wrote in between, the conflict is reported and both copies
// stay as they are until the person chooses. Nothing here touches the
// repository.

export const LOCAL_DELAY_MS = 1_000;
export const SERVER_DELAY_MS = 5_000;
const RETRY_MS = 30_000;

export interface DraftConflict {
  path: string;
  /** The newer server copy, or null when it was deleted elsewhere. */
  current: DraftMeta | null;
}

export interface DraftSyncState {
  /** A local write is waiting for typing to stop. */
  writing: boolean;
  /** Last local write, Unix ms. */
  savedAt?: number;
  conflicts: DraftConflict[];
}

export interface DraftSyncOptions {
  store: DraftStore;
  gateway?: DraftsGateway;
  user: string;
  repoId: number;
  device: string;
  /** Whether drafts go to the server (Preferences → Editor). */
  server: () => boolean;
  onConflict?: (path: string, current: DraftMeta | null) => void;
  onState?: (state: DraftSyncState) => void;
  localDelayMs?: number;
  serverDelayMs?: number;
  now?: () => number;
}

export type DraftSync = ReturnType<typeof createDraftSync>;

export function createDraftSync(o: DraftSyncOptions) {
  const localDelay = o.localDelayMs ?? LOCAL_DELAY_MS;
  const serverDelay = o.serverDelayMs ?? SERVER_DELAY_MS;
  const now = o.now ?? Date.now;
  const records = new Map<string, LocalDraft>();
  const queued = new Map<string, { content: string; baseSha: string; timer: ReturnType<typeof setTimeout> }>();
  const serverTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const inflight = new Set<string>();
  const again = new Set<string>();
  const conflicts = new Map<string, DraftMeta | null>();
  let savedAt: number | undefined;
  let authFailed = false;
  let disposed = false;

  const state = (): DraftSyncState => ({
    writing: queued.size > 0,
    savedAt,
    conflicts: [...conflicts].map(([path, current]) => ({ path, current })),
  });
  const emit = () => {
    if (!disposed) o.onState?.(state());
  };
  const canServer = () => o.gateway !== undefined && o.server() && !authFailed && !disposed;
  let writes: Promise<unknown> = Promise.resolve();
  const keep = (rec: LocalDraft) => {
    if (disposed) return;
    records.set(rec.path, rec);
    const put = o.store.put({ ...rec });
    writes = Promise.all([writes, put]);
  };

  const scheduleServer = (path: string, delay = serverDelay) => {
    if (!canServer()) return;
    clearTimeout(serverTimers.get(path));
    serverTimers.set(
      path,
      setTimeout(() => void pushServer(path), delay),
    );
  };

  async function pushServer(path: string): Promise<void> {
    serverTimers.delete(path);
    const gateway = o.gateway;
    if (!gateway || !canServer() || conflicts.has(path)) return;
    if (inflight.has(path)) {
      again.add(path);
      return;
    }
    const sent = records.get(path);
    if (!sent?.pending) return;
    inflight.add(path);
    let retry = false;
    try {
      const meta = await gateway.put(o.repoId, path, { baseSha: sent.baseSha, device: o.device, content: sent.content }, sent.server?.etag);
      const cur = records.get(path);
      if (!cur) {
        // Discarded while the write was in flight.
        await gateway.remove(o.repoId, path).catch(() => undefined);
      } else {
        const pending = cur.content !== sent.content || cur.baseSha !== sent.baseSha;
        keep({ ...cur, server: { etag: meta.etag, updatedAt: meta.updatedAt }, pending });
        if (pending) again.add(path);
      }
    } catch (err) {
      if (err instanceof DraftConflictError) {
        conflicts.set(path, err.current);
        o.onConflict?.(path, err.current);
      } else if (err instanceof AuthRequiredError) {
        authFailed = true;
      } else retry = true;
    } finally {
      inflight.delete(path);
      if (again.delete(path)) scheduleServer(path);
      else if (retry) scheduleServer(path, RETRY_MS);
      emit();
    }
  }

  const writeLocal = (path: string) => {
    const q = queued.get(path);
    if (!q) return;
    clearTimeout(q.timer);
    queued.delete(path);
    const prev = records.get(path);
    if (prev && prev.content === q.content && prev.baseSha === q.baseSha) return emit();
    const rec: LocalDraft = {
      user: o.user,
      repoId: o.repoId,
      path,
      content: q.content,
      baseSha: q.baseSha,
      updatedAt: now(),
      pending: true,
      ...(prev?.server ? { server: prev.server } : {}),
    };
    keep(rec);
    savedAt = rec.updatedAt;
    emit();
    scheduleServer(path);
  };

  const cancel = (path: string) => {
    clearTimeout(queued.get(path)?.timer);
    queued.delete(path);
    clearTimeout(serverTimers.get(path));
    serverTimers.delete(path);
  };

  /** Takes a server copy as this device's draft (restore or "Use it"). */
  const adopt = (d: ServerDraft) => {
    cancel(d.path);
    keep({
      user: o.user,
      repoId: o.repoId,
      path: d.path,
      content: d.content,
      baseSha: d.baseSha,
      updatedAt: now(),
      server: { etag: d.etag, updatedAt: d.updatedAt },
      pending: false,
    });
    conflicts.delete(d.path);
    emit();
  };

  return {
    /** Reads this repository's local drafts. */
    async load(): Promise<LocalDraft[]> {
      const list = await o.store.list(o.user, o.repoId);
      for (const d of list) records.set(d.path, d);
      // Drafts that never reached the server go out again.
      for (const d of list) if (d.pending) scheduleServer(d.path);
      return list.map((d) => ({ ...d }));
    },
    state,
    /** The buffer at `path` now reads `content`, based on the commit `baseSha`. */
    edit(path: string, content: string, baseSha: string) {
      const q = queued.get(path);
      if (q && q.content === content && q.baseSha === baseSha) return;
      const rec = records.get(path);
      if (!q && rec && rec.content === content && rec.baseSha === baseSha) return;
      clearTimeout(q?.timer);
      queued.set(path, { content, baseSha, timer: setTimeout(() => writeLocal(path), localDelay) });
      emit();
    },
    /** Writes every waiting local draft now (the tab is going away). */
    flush(): Promise<void> {
      for (const p of [...queued.keys()]) writeLocal(p);
      return writes.then(() => undefined);
    },
    /** Sends every draft the server does not have yet, now (before signing out). */
    async pushPending(): Promise<void> {
      if (!canServer()) return;
      const paths = [...records.values()].filter((r) => r.pending).map((r) => r.path);
      for (const p of paths) {
        clearTimeout(serverTimers.get(p));
        await pushServer(p);
      }
      await writes;
    },
    /** Deletes the local and the server draft of `path` (saved, or the person discarded it). */
    async discard(path: string): Promise<void> {
      cancel(path);
      const rec = records.get(path);
      records.delete(path);
      conflicts.delete(path);
      await o.store.remove(o.user, o.repoId, path);
      if (o.gateway && !authFailed && (o.server() || rec?.server)) await o.gateway.remove(o.repoId, path).catch(() => undefined);
      emit();
    },
    adopt,
    /** A newer server copy was found on open: hold the server sync of `path` until the person chooses. */
    markConflict(path: string, current: DraftMeta | null) {
      conflicts.set(path, current);
      emit();
    },
    /** "Keep mine": replace the newer server copy, against the version that was shown. */
    async keepMine(path: string): Promise<void> {
      if (!conflicts.has(path)) return;
      const current = conflicts.get(path) ?? null;
      const rec = records.get(path);
      conflicts.delete(path);
      if (!rec) return emit();
      const next: LocalDraft = { ...rec, pending: true };
      if (current) next.server = { etag: current.etag, updatedAt: current.updatedAt };
      else delete next.server;
      keep(next);
      emit();
      await pushServer(path);
    },
    /** "Use it": fetch the newer server copy and make it this device's draft. */
    async useTheirs(path: string): Promise<ServerDraft | undefined> {
      if (!o.gateway) return undefined;
      const d = await o.gateway.get(o.repoId, path).catch(() => undefined);
      if (!d) return undefined;
      adopt(d);
      return d;
    },
    /** Drafts stay in this browser only; the server copies of this repository are deleted. */
    async disableServer(): Promise<void> {
      for (const timer of serverTimers.values()) clearTimeout(timer);
      serverTimers.clear();
      conflicts.clear();
      if (o.gateway && !authFailed) await o.gateway.removeAll(o.repoId).catch(() => undefined);
      for (const rec of [...records.values()]) {
        const next: LocalDraft = { ...rec, pending: true };
        delete next.server;
        keep(next);
      }
      emit();
    },
    /** Drafts go to the server again (the preference was turned back on). */
    enableServer() {
      for (const rec of records.values()) if (rec.pending) scheduleServer(rec.path);
    },
    /** Flushes waiting local drafts and stops every timer. */
    dispose() {
      for (const p of [...queued.keys()]) writeLocal(p);
      disposed = true;
      for (const timer of serverTimers.values()) clearTimeout(timer);
      serverTimers.clear();
    },
  };
}

/**
 * What changed in the buffers for drafts: edited buffers to draft, and
 * buffers seen edited that are clean again (saved, or edited back) whose
 * drafts go. A buffer waiting for a merge choice is left alone. `tracked`
 * is updated in place.
 */
export function bufferChanges(tracked: Set<string>, buffers: Buffers): { edits: { path: string; text: string }[]; clears: string[] } {
  const edits: { path: string; text: string }[] = [];
  const clears: string[] = [];
  for (const [path, b] of Object.entries(buffers)) {
    if (b.merge) continue;
    if (b.text !== b.base) {
      edits.push({ path, text: b.text });
      tracked.add(path);
    } else if (tracked.delete(path)) clears.push(path);
  }
  return { edits, clears };
}

/** "Firefox on Linux": a short, non-identifying label for the device a draft came from. */
export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\/|FxiOS/.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS/.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'macOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : undefined;
  return os ? `${browser} on ${os}` : browser;
}

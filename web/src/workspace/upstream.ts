import { AuthRequiredError, ConflictError, type BlobInfo, type FileChange, type RepoGateway, type Repository, type UpstreamStatus } from '../domain';
import { en, type Messages } from '../i18n/en';
import { describeError, runSave, unsavedChanges, type Buffers, type SaveOutcome } from './model';
import { merge3 } from './merge3';

// Keeping the working branch up to date with the default branch. While the
// user edits, galley only watches the default branch and offers to bring its
// changes in; it merges by itself only right before a save, so a proposal is
// always built on the latest version. Edits are never discarded.

export const POLL_MS = 60_000;

export interface UpstreamWatcherOptions {
  defaultHead: () => Promise<string>;
  upstream: (headSha: string) => Promise<UpstreamStatus>;
  onStatus: (status: UpstreamStatus) => void;
  intervalMs?: number;
  /** True while the tab is visible; hidden tabs do not poll. */
  visible?: () => boolean;
  /** Where `focus` and `visibilitychange` arrive; window and document by default. */
  events?: EventTarget;
}

/**
 * Polls the default branch head while the tab is visible (and on focus). The
 * cheap ref lookup runs every interval; the compare only when the default head
 * or the working head moved. Failures are ignored: the next check retries.
 */
export function createUpstreamWatcher(options: UpstreamWatcherOptions) {
  const visible = options.visible ?? (() => globalThis.document?.visibilityState !== 'hidden');
  let head: string | undefined;
  let lastKey: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let again = false;
  let disposed = false;

  const check = async (): Promise<void> => {
    if (!head || disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const checkedHead = head;
      const latest = await options.defaultHead();
      if (`${checkedHead}:${latest}` !== lastKey) {
        const status = await options.upstream(checkedHead);
        lastKey = `${checkedHead}:${status.defaultHead}`;
        if (!disposed && checkedHead === head) options.onStatus(status);
      }
    } catch {
      // Offline or rate limited: try again on the next tick.
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      await check();
    }
  };

  const onVisible = () => {
    if (visible()) void check();
  };
  const focusTarget: EventTarget | undefined = options.events ?? globalThis.window;
  const visibilityTarget: EventTarget | undefined = options.events ?? globalThis.document;

  return {
    start(headSha: string) {
      head = headSha;
      focusTarget?.addEventListener('focus', onVisible);
      visibilityTarget?.addEventListener('visibilitychange', onVisible);
      timer = setInterval(onVisible, options.intervalMs ?? POLL_MS);
      onVisible();
    },
    /** The working head moved (a save or a bring-in); check against it. */
    setHead(headSha: string) {
      if (headSha === head) return;
      head = headSha;
      onVisible();
    },
    check: onVisible,
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      focusTarget?.removeEventListener('focus', onVisible);
      visibilityTarget?.removeEventListener('visibilitychange', onVisible);
    },
  };
}

/** Whether to offer "Bring them in": new changes exist and were not dismissed at this default head. */
export function shouldOffer(status: UpstreamStatus | undefined, dismissedHead: string | undefined): boolean {
  return status !== undefined && status.behind > 0 && status.defaultHead !== dismissedHead;
}

/** New repository text per path, for open files whose text changed upstream; undefined when the file is gone. */
export type Bases = Record<string, string | undefined>;

/**
 * Reads every open file at the new head and returns the ones whose text
 * differs from the base they were opened at. `snapshot` is taken before any
 * await, so it says what each buffer was based on.
 */
export async function upstreamBases(snapshot: Buffers, read: (path: string) => Promise<string>): Promise<{ bases: Bases }> {
  const bases: Bases = {};
  const entries = Object.entries(snapshot);
  await Promise.all(
    entries.map(async ([path, buffer]) => {
      const next = await read(path).catch(() => undefined);
      if (next !== buffer.base) bases[path] = next;
    }),
  );
  return { bases };
}

export interface Rebased {
  buffers: Buffers;
  /** Edited files into which the default branch's changes were merged cleanly. */
  merged: string[];
  /** Edited files where both sides changed the same lines; they need a choice before saving. */
  conflicted: string[];
}

/**
 * Moves buffers onto the new head. A file without edits takes the new text
 * (or closes when it was deleted). An edited file gets a line-level
 * three-way merge of what the user started from, the user's text and the new
 * text, so neither side's changes are lost: a clean merge becomes the buffer
 * (still unsaved), a conflict keeps the user's text and the regions to choose
 * from. "Edited" is judged against `before`, the snapshot taken before the
 * reads, and a file typed into since then counts as edited too.
 */
export function rebase(current: Buffers, bases: Bases, before: Buffers): Rebased {
  const buffers: Buffers = {};
  const merged: string[] = [];
  const conflicted: string[] = [];
  for (const [path, now] of Object.entries(current)) {
    if (!(path in bases)) {
      buffers[path] = now;
      continue;
    }
    const next = bases[path];
    const then = before[path] ?? now;
    const edited = then.text !== then.base || now.text !== then.text || now.merge !== undefined;
    if (!edited) {
      if (next !== undefined) buffers[path] = { base: next, text: next };
      continue;
    }
    if (next === undefined) {
      // Deleted on the default branch: keep the user's text; saving adds it back.
      buffers[path] = { ...now, base: '' };
      continue;
    }
    const started = now.merge?.base ?? then.base;
    const result = merge3(started, now.text, next);
    if (result.kind === 'clean') {
      buffers[path] = { base: next, text: result.text };
      merged.push(path);
    } else {
      buffers[path] = { base: next, text: now.text, merge: { base: started, regions: result.regions } };
      conflicted.push(path);
    }
  }
  return { buffers, merged: merged.sort(), conflicted: conflicted.sort() };
}

/** Files with conflicts that still need a choice. */
export function unresolvedPaths(buffers: Buffers): string[] {
  return Object.keys(buffers)
    .filter((p) => buffers[p]?.merge !== undefined)
    .sort();
}

export interface Upstreamed {
  headSha: string;
  files: string[];
  truncated: boolean;
  blobs?: Record<string, BlobInfo>;
  bases: Bases;
  /** The buffers the reads were based on. */
  before: Buffers;
}

/**
 * Brings the default branch into the working branch and reads the open files
 * at the new head. `snapshot` is the buffers before any await; apply the
 * result with `rebase(current, upstream.bases, upstream.before)`. Used by
 * "Bring them in" and by every save.
 */
export async function bringIn(
  gateway: RepoGateway,
  repo: Repository,
  headSha: string,
  snapshot: Buffers,
): Promise<{ kind: 'current' } | { kind: 'conflict' } | { kind: 'updated'; upstream: Upstreamed }> {
  const result = await gateway.bringInDefault(repo, headSha);
  if (result.kind !== 'updated') return result;
  const { bases } = await upstreamBases(snapshot, (path) => gateway.readFile(repo, path, result.headSha));
  return {
    kind: 'updated',
    upstream: { headSha: result.headSha, files: result.files, truncated: result.truncated, blobs: result.blobs, bases, before: snapshot },
  };
}

export type SyncedSaveOutcome =
  | (SaveOutcome & { upstream?: Upstreamed; merged?: string[] })
  /** GitHub could not merge the default branch into the proposal; nothing was saved. */
  | { kind: 'upstream-conflict' }
  /** The default branch changed the same lines as the user; nothing was saved, the user chooses first. */
  | { kind: 'upstream-conflicted'; upstream: Upstreamed; paths: string[] }
  /** Some files still have conflicts to resolve; nothing was sent. */
  | { kind: 'unresolved'; paths: string[] };

/**
 * Every save first brings the default branch in, merges its changes into
 * edited files, then commits on top of the result; `extra` (uploaded files)
 * joins the same commit. Open conflicts, a merge
 * conflict on GitHub, or lines changed on both sides stop the save.
 */
export async function saveWithUpstream(
  gateway: RepoGateway,
  repo: Repository,
  buffers: Buffers,
  message: string,
  headSha: string,
  t: Messages = en,
  extra: FileChange[] = [],
): Promise<SyncedSaveOutcome> {
  const unresolved = unresolvedPaths(buffers);
  if (unresolved.length) return { kind: 'unresolved', paths: unresolved };
  let brought;
  try {
    brought = await bringIn(gateway, repo, headSha, buffers);
  } catch (err) {
    if (err instanceof ConflictError) return { kind: 'conflict', copies: unsavedChanges(buffers) };
    if (err instanceof AuthRequiredError) return { kind: 'auth' };
    return { kind: 'error', message: describeError(err, t) };
  }
  if (brought.kind === 'conflict') return { kind: 'upstream-conflict' };
  if (brought.kind === 'current') return runSave(gateway, repo, buffers, message, headSha, t, extra);
  const { upstream } = brought;
  const rebased = rebase(buffers, upstream.bases, buffers);
  if (rebased.conflicted.length > 0) return { kind: 'upstream-conflicted', upstream, paths: rebased.conflicted };
  const outcome = await runSave(gateway, repo, rebased.buffers, message, upstream.headSha, t, extra);
  return { ...outcome, upstream, merged: rebased.merged };
}

/** Link where a person can resolve a conflict between the proposal and the default branch. */
export function conflictUrl(repo: Repository, branch: string): string {
  const seg = (s: string) => s.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${seg(repo.fullName)}/compare/${seg(repo.defaultBranch)}...${seg(branch)}`;
}

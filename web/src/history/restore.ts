import type { ChangedFile, FileChange } from '../domain';
import type { Buffers } from '../workspace/model';

// Restoring an earlier version never writes the default branch: it turns the
// version's files into unsaved changes in the person's working buffers, which
// they then save for review like any edit.

export type RestoreOp = { path: string; op: 'write' } | { path: string; op: 'delete' };

/** Text goes into a buffer; other files and deletions are pending changes for the next save. */
export type RestoreChange =
  | { path: string; kind: 'text'; text: string }
  | { path: string; kind: 'bytes'; base64: string }
  | { path: string; kind: 'delete' };

export type PreparedChange = Exclude<RestoreChange, { kind: 'text' }> | { path: string; kind: 'text'; text: string; base: string };

/**
 * What makes the working files equal the version: write every file whose blob
 * differs (or is missing), delete every file the version did not have, and
 * also reset files with unsaved edits. Sorted by path.
 */
export function planRestore(oldBlobs: Record<string, string>, headBlobs: Record<string, string>, dirty: readonly string[]): RestoreOp[] {
  const ops = new Map<string, RestoreOp>();
  for (const [path, sha] of Object.entries(oldBlobs)) if (headBlobs[path] !== sha) ops.set(path, { path, op: 'write' });
  for (const path of Object.keys(headBlobs)) if (!(path in oldBlobs)) ops.set(path, { path, op: 'delete' });
  for (const path of dirty) if (!ops.has(path)) ops.set(path, path in oldBlobs ? { path, op: 'write' } : { path, op: 'delete' });
  return [...ops.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * One file of a comparison "version...current": bring back the version's side.
 * A file added since is deleted; a renamed file comes back under its old name.
 */
export function fileRestoreOps(file: ChangedFile): RestoreOp[] {
  if (file.status === 'added') return [{ path: file.path, op: 'delete' }];
  if (file.status === 'renamed' && file.previousPath) {
    return [
      { path: file.previousPath, op: 'write' },
      { path: file.path, op: 'delete' },
    ];
  }
  return [{ path: file.path, op: 'write' }];
}

/**
 * Finds the base of each restored text: the open buffer's base, else the text
 * at the working head, else empty (the file comes back as a new file).
 */
export async function prepareRestore(
  changes: RestoreChange[],
  buffers: Buffers,
  files: readonly string[],
  readBase: (path: string) => Promise<string>,
): Promise<PreparedChange[]> {
  return Promise.all(
    changes.map(async (c): Promise<PreparedChange> => {
      if (c.kind !== 'text') return c;
      const open = buffers[c.path];
      const base = open ? open.base : files.includes(c.path) ? await readBase(c.path) : '';
      return { ...c, base };
    }),
  );
}

export interface Restored {
  buffers: Buffers;
  /** Pending binary files and deletions, for the next save. */
  pending: FileChange[];
  /** Restored files that the working head does not have. */
  created: string[];
  /** Files that the next save deletes. */
  deleted: string[];
}

/** Applies prepared changes to the buffers and the pending list. Nothing is sent. */
export function applyRestore(buffers: Buffers, pending: FileChange[], changes: PreparedChange[], files: readonly string[]): Restored {
  const next = new Map(Object.entries(buffers));
  const queue = new Map(pending.map((c) => [c.path, c]));
  const created = new Set<string>();
  for (const c of changes) {
    if (c.kind === 'text') {
      queue.delete(c.path);
      next.set(c.path, { base: c.base, text: c.text });
      if (!files.includes(c.path)) created.add(c.path);
      continue;
    }
    next.delete(c.path);
    created.delete(c.path);
    if (c.kind === 'bytes') queue.set(c.path, { path: c.path, content: c.base64, encoding: 'base64' });
    else if (files.includes(c.path)) queue.set(c.path, { path: c.path, content: '', delete: true });
    else queue.delete(c.path);
  }
  const queued = [...queue.values()];
  return {
    buffers: Object.fromEntries(next),
    pending: queued,
    created: [...created].sort(),
    deleted: queued.filter((c) => c.delete).map((c) => c.path),
  };
}

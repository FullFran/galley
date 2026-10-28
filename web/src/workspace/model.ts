import {
  AuthRequiredError,
  ConflictError,
  NotFoundError,
  NotTextError,
  PermissionError,
  TransientError,
  type FileChange,
  type RepoGateway,
  type Repository,
} from '../domain';
import { en, type Messages } from '../i18n/en';

/** An opened file: `base` is the text at the last loaded or saved head, `text` the user's buffer. */
export interface Buffer {
  base: string;
  text: string;
}

/** Buffers are kept in memory only, keyed by path. */
export type Buffers = Record<string, Buffer>;

export type SaveOutcome =
  | { kind: 'saved'; headSha: string; pullRequestUrl?: string; saved: FileChange[] }
  | { kind: 'conflict'; copies: FileChange[] }
  | { kind: 'auth' }
  | { kind: 'error'; message: string };

export function dirtyPaths(buffers: Buffers): string[] {
  return Object.keys(buffers)
    .filter((path) => buffers[path]?.text !== buffers[path]?.base)
    .sort();
}

export function defaultMessage(paths: string[], t: Messages = en): string {
  const names = paths.map((p) => p.slice(p.lastIndexOf('/') + 1));
  if (names.length <= 4) return t.save.defaultMessage(names.join(', '), 0);
  return t.save.defaultMessage(names.slice(0, 3).join(', '), names.length - 3);
}

/** The edited buffers as file changes, in path order. */
export function unsavedChanges(buffers: Buffers): FileChange[] {
  return dirtyPaths(buffers).map((path) => ({ path, content: buffers[path]?.text ?? '' }));
}

/** Saves every edited buffer as one change on top of `headSha`. */
export async function runSave(
  gateway: RepoGateway,
  repo: Repository,
  buffers: Buffers,
  message: string,
  headSha: string,
  t: Messages = en,
): Promise<SaveOutcome> {
  const changes = unsavedChanges(buffers);
  try {
    const result = await gateway.save(repo, changes, message, headSha);
    return { kind: 'saved', headSha: result.commitSha, pullRequestUrl: result.pullRequestUrl, saved: changes };
  } catch (err) {
    if (err instanceof ConflictError) return { kind: 'conflict', copies: changes };
    if (err instanceof AuthRequiredError) return { kind: 'auth' };
    return { kind: 'error', message: describeError(err, t) };
  }
}

/** Marks the saved content as the new base; edits made during the save stay unsaved. */
export function applySaved(buffers: Buffers, saved: FileChange[]): Buffers {
  const next = { ...buffers };
  for (const { path, content } of saved) {
    const current = next[path];
    if (current) next[path] = { base: content, text: current.text };
  }
  return next;
}

/** A short explanation of a gateway failure for people who do not use git. */
export function describeError(err: unknown, t: Messages = en): string {
  const m = t.errors;
  if (err instanceof TransientError) return m.network;
  if (err instanceof NotTextError) return m.notText;
  if (err instanceof PermissionError) return m.permission;
  if (err instanceof NotFoundError) return m.notFound;
  if (err instanceof AuthRequiredError) return m.session;
  return m.generic;
}

/**
 * True when the text of a file that was already open changed. Opening a file
 * (a new buffer with the repository's text) is not an edit, so the preview is
 * not marked out of date by it.
 */
export function textsEdited(before: Buffers, after: Buffers): boolean {
  for (const k of Object.keys(after)) if (before[k] !== undefined && before[k]?.text !== after[k]?.text) return true;
  return false;
}

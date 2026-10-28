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

export function defaultMessage(paths: string[]): string {
  const names = paths.map((p) => p.slice(p.lastIndexOf('/') + 1));
  if (names.length <= 4) return `Update ${names.join(', ')}`;
  return `Update ${names.slice(0, 3).join(', ')} and ${names.length - 3} more files`;
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
): Promise<SaveOutcome> {
  const changes = unsavedChanges(buffers);
  try {
    const result = await gateway.save(repo, changes, message, headSha);
    return { kind: 'saved', headSha: result.commitSha, pullRequestUrl: result.pullRequestUrl, saved: changes };
  } catch (err) {
    if (err instanceof ConflictError) return { kind: 'conflict', copies: changes };
    if (err instanceof AuthRequiredError) return { kind: 'auth' };
    return { kind: 'error', message: describeError(err) };
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
export function describeError(err: unknown): string {
  if (err instanceof TransientError) {
    return 'GitHub or the galley server could not be reached. Check your connection and try again.';
  }
  if (err instanceof NotTextError) return 'This file is not plain text, so it cannot be edited here.';
  if (err instanceof PermissionError) return 'You do not have permission to change this repository.';
  if (err instanceof NotFoundError) return 'This repository or file could not be found. It may have been moved.';
  if (err instanceof AuthRequiredError) return 'Your session has ended. Please sign in again.';
  return 'Something went wrong. Try again in a moment.';
}

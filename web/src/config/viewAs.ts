import { visibleFiles, type ProjectConfig } from './project';

// Repository admins see every file by default and can switch to the
// co-author view to check what their co-authors get. The switch only narrows
// the admin's own list; co-authors are never shown more. Project settings
// stay available in both modes. The choice is kept per repository in this
// browser; every storage access is guarded.

export type ViewAs = 'all' | 'coauthor';

const key = (repo: string) => `galley:view-as:${repo}`;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function filesInView(files: readonly string[], project: ProjectConfig, admin: boolean, mode: ViewAs): string[] {
  return visibleFiles(files, project, admin && mode === 'all');
}

export function readViewAs(repo: string, store: Storage | undefined = storage()): ViewAs {
  try {
    return store?.getItem(key(repo)) === 'coauthor' ? 'coauthor' : 'all';
  } catch {
    return 'all';
  }
}

export function writeViewAs(repo: string, mode: ViewAs, store: Storage | undefined = storage()): void {
  try {
    store?.setItem(key(repo), mode);
  } catch {
    // Not remembered; the switch still works for this visit.
  }
}

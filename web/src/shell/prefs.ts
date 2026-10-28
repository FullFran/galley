// Small per-browser conveniences: the Contents tab per repository, the
// dismissed "not set up" banner per repository and the Preferences dialog.
// Storage can be missing or blocked; every access is guarded and falls back to
// the default.

export type ContentsTab = 'outline' | 'files';

export interface Prefs {
  /** Auto-compile for repositories where the user has not chosen yet. */
  autoCompile?: boolean;
  /** Writing or Code; unset means "use the project default". */
  editorMode?: EditorMode;
  /** Vim key bindings in the editor (loaded only when on). */
  vim?: boolean;
}

export type EditorMode = 'writing' | 'code';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function local(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const tabKey = (repo: string) => `galley:contents-tab:${repo}`;
const setupKey = (repo: string) => `galley:setup-dismissed:${repo}`;
const PREFS_KEY = 'galley:prefs';

function read(store: Store | undefined, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: Store | undefined, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // Not remembered; it still works for this visit.
  }
}

export function readContentsTab(repo: string, store: Store | undefined = local()): ContentsTab {
  return read(store, tabKey(repo)) === 'files' ? 'files' : 'outline';
}

export function writeContentsTab(repo: string, tab: ContentsTab, store: Store | undefined = local()): void {
  write(store, tabKey(repo), tab);
}

export function isSetupDismissed(repo: string, store: Store | undefined = local()): boolean {
  return read(store, setupKey(repo)) === '1';
}

export function dismissSetup(repo: string, store: Store | undefined = local()): void {
  write(store, setupKey(repo), '1');
}

export function readPrefs(store: Store | undefined = local()): Prefs {
  try {
    const parsed: unknown = JSON.parse(read(store, PREFS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return {};
    const { autoCompile, editorMode, vim } = parsed as Record<string, unknown>;
    const prefs: Prefs = {};
    if (typeof autoCompile === 'boolean') prefs.autoCompile = autoCompile;
    if (editorMode === 'writing' || editorMode === 'code') prefs.editorMode = editorMode;
    if (typeof vim === 'boolean') prefs.vim = vim;
    return prefs;
  } catch {
    return {};
  }
}

const listeners = new Set<(prefs: Prefs) => void>();

/** Calls `listener` after every `writePrefs` in this tab; returns the unsubscribe. */
export function onPrefsChange(listener: (prefs: Prefs) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function writePrefs(prefs: Prefs, store: Store | undefined = local()): void {
  write(store, PREFS_KEY, JSON.stringify(prefs));
  for (const listener of listeners) listener(prefs);
}

/** The person's own choice, else `.galley.yml`'s `editor.default_mode`, else Code for admins and Writing for co-authors. */
export function resolveEditorMode(chosen: EditorMode | undefined, configured: EditorMode | undefined, admin: boolean): EditorMode {
  return chosen ?? configured ?? (admin ? 'code' : 'writing');
}

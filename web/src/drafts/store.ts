// Local drafts: every edited buffer is kept in this browser (IndexedDB), per
// user, repository and path, with the commit its text started from. The port
// has an in-memory adapter for tests and for browsers where IndexedDB is
// missing or blocked (private windows): drafts then last for the visit only.
// Every IndexedDB call is guarded; a failure never reaches the editor.

export interface LocalDraft {
  user: string;
  repoId: number;
  path: string;
  content: string;
  /** Commit SHA the buffer's base text was read at. */
  baseSha: string;
  /** Last local write, Unix ms. */
  updatedAt: number;
  /** The server copy this draft last matched (its version), when synced. */
  server?: { etag: string; updatedAt: string };
  /** True while `content` has not reached the server. */
  pending: boolean;
}

export interface DraftStore {
  list(user: string, repoId: number): Promise<LocalDraft[]>;
  get(user: string, repoId: number, path: string): Promise<LocalDraft | undefined>;
  /** False when the draft could not be stored. */
  put(draft: LocalDraft): Promise<boolean>;
  remove(user: string, repoId: number, path: string): Promise<void>;
  /** Every draft of `user`, in all repositories (sign-out). */
  listUser(user: string): Promise<LocalDraft[]>;
}

const key = (user: string, repoId: number, path: string) => `${user}\u0000${repoId}\u0000${path}`;

export function createMemoryDraftStore(): DraftStore {
  const map = new Map<string, LocalDraft>();
  return {
    async list(user, repoId) {
      return [...map.values()].filter((d) => d.user === user && d.repoId === repoId).map((d) => ({ ...d }));
    },
    async get(user, repoId, path) {
      const d = map.get(key(user, repoId, path));
      return d && { ...d };
    },
    async put(draft) {
      map.set(key(draft.user, draft.repoId, draft.path), { ...draft });
      return true;
    },
    async remove(user, repoId, path) {
      map.delete(key(user, repoId, path));
    },
    async listUser(user) {
      return [...map.values()].filter((d) => d.user === user).map((d) => ({ ...d }));
    },
  };
}

const DB = 'galley-drafts';
const STORE = 'drafts';
const BY_REPO = 'by-repo';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb'));
  });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.createObjectStore(STORE, { keyPath: ['user', 'repoId', 'path'] });
      store.createIndex(BY_REPO, ['user', 'repoId']);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb'));
    req.onblocked = () => reject(new Error('indexeddb blocked'));
  });
}

function valid(v: unknown): v is LocalDraft {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.user === 'string' &&
    typeof d.repoId === 'number' &&
    typeof d.path === 'string' &&
    typeof d.content === 'string' &&
    typeof d.baseSha === 'string' &&
    typeof d.updatedAt === 'number'
  );
}

/** IndexedDB when it opens, else memory. */
export function createIndexedDbDraftStore(factory: IDBFactory | undefined = safeFactory()): DraftStore {
  const fallback = createMemoryDraftStore();
  let db: Promise<IDBDatabase | undefined> | undefined;
  const open = () => {
    db ??= factory ? openDb(factory).catch(() => undefined) : Promise.resolve(undefined);
    return db;
  };
  const tx = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> => {
    const d = await open();
    if (!d) return undefined;
    return request(run(d.transaction(STORE, mode).objectStore(STORE)));
  };
  return {
    async list(user, repoId) {
      try {
        if (!(await open())) return fallback.list(user, repoId);
        const all = await tx('readonly', (s) => s.index(BY_REPO).getAll([user, repoId]));
        return (all ?? []).filter(valid);
      } catch {
        return [];
      }
    },
    async get(user, repoId, path) {
      try {
        if (!(await open())) return fallback.get(user, repoId, path);
        const d: unknown = await tx('readonly', (s) => s.get([user, repoId, path]));
        return valid(d) ? d : undefined;
      } catch {
        return undefined;
      }
    },
    async put(draft) {
      try {
        if (!(await open())) return fallback.put(draft);
        await tx('readwrite', (s) => s.put({ ...draft }));
        return true;
      } catch {
        // Quota or a closed database: the draft lives in memory for this visit.
        return fallback.put(draft);
      }
    },
    async remove(user, repoId, path) {
      await fallback.remove(user, repoId, path);
      try {
        if (await open()) await tx('readwrite', (s) => s.delete([user, repoId, path]));
      } catch {
        // Best effort.
      }
    },
    async listUser(user) {
      try {
        if (!(await open())) return fallback.listUser(user);
        const range = IDBKeyRange.bound([user, -Infinity], [user, Infinity]);
        const all = await tx('readonly', (s) => s.index(BY_REPO).getAll(range));
        return [...(all ?? []).filter(valid), ...(await fallback.listUser(user))];
      } catch {
        return fallback.listUser(user);
      }
    },
  };
}

let shared: DraftStore | undefined;
/** The browser's draft store, shared by every screen. */
export const draftStore = (): DraftStore => (shared ??= createIndexedDbDraftStore());

function safeFactory(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB ?? undefined;
  } catch {
    return undefined;
  }
}

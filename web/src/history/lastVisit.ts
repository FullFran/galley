// "What changed since your last visit": the default-branch head each person
// last saw, per repository, in localStorage. Best effort: blocked storage
// means no banner, never an error.

export const LAST_SEEN_KEY = 'galley:last-seen';
const MAX_ENTRIES = 200;
const SHA = /^[0-9a-f]{7,40}$/;

type Read = Pick<Storage, 'getItem'>;
type Write = Pick<Storage, 'getItem' | 'setItem'>;

const keyOf = (login: string, fullName: string) => `${login.toLowerCase()}@${fullName.toLowerCase()}`;

function readMap(store: Read | undefined): Record<string, string> {
  try {
    const raw = store?.getItem(LAST_SEEN_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

export function localStore(): Write | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readLastSeen(store: Read | undefined, login: string, fullName: string): string | undefined {
  const value = readMap(store)[keyOf(login, fullName)];
  return typeof value === 'string' && SHA.test(value) ? value : undefined;
}

export function writeLastSeen(store: Write | undefined, login: string, fullName: string, sha: string): void {
  if (!SHA.test(sha)) return;
  try {
    const key = keyOf(login, fullName);
    // Insertion order is the age: the latest goes last, the oldest beyond the cap go.
    const entries = [...Object.entries(readMap(store)).filter(([k]) => k !== key), [key, sha]];
    store?.setItem(LAST_SEEN_KEY, JSON.stringify(Object.fromEntries(entries.slice(-MAX_ENTRIES))));
  } catch {
    // Best effort: the banner just does not show next time.
  }
}

export interface LastVisitBanner {
  since: string;
  head: string;
  /** Versions (commits) on the default branch since then. */
  count: number;
}

/** The banner to show, if the head moved since a remembered visit. */
export function lastVisitBanner(since: string | undefined, head: string, count: number): LastVisitBanner | undefined {
  if (!since || since === head || count <= 0) return undefined;
  return { since, head, count };
}

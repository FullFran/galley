import type { DraftStore, LocalDraft } from './store';
import type { DraftSync } from './sync';

// Signing out removes the person's local drafts from this browser (a shared
// computer must not keep them). Drafts already on the server survive there;
// drafts that exist only here are counted first so the person can be warned.

const active = new Set<DraftSync>();

/** The open workspace's sync takes part in sign-out; returns the unregister. */
export function registerSync(sync: DraftSync): () => void {
  active.add(sync);
  return () => void active.delete(sync);
}

/** A draft is safe on the server when its last sync succeeded and nothing changed since. */
const synced = (d: LocalDraft) => !d.pending && d.server !== undefined;

export function signOutPlan(drafts: LocalDraft[]): { unsynced: number } {
  return { unsynced: drafts.filter((d) => !synced(d)).length };
}

/** Writes waiting drafts, sends unsent ones to the server, then counts what only exists here. */
export async function prepareSignOut(user: string, store: DraftStore): Promise<{ unsynced: number }> {
  for (const s of active) await s.flush();
  for (const s of active) await s.pushPending().catch(() => undefined);
  return signOutPlan(await store.listUser(user));
}

/** Deletes `user`'s local drafts; `keepUnsynced` keeps the ones the server does not have. */
export async function clearUserDrafts(user: string, store: DraftStore, { keepUnsynced = false } = {}): Promise<void> {
  // The session is over: stop every sync first, so nothing writes a draft back.
  for (const s of active) {
    await s.flush();
    s.dispose();
  }
  for (const d of await store.listUser(user)) {
    if (keepUnsynced && !synced(d)) continue;
    await store.remove(user, d.repoId, d.path);
  }
}

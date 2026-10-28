import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftsGateway } from './http';
import { DraftConflictError } from './http';
import { clearUserDrafts, prepareSignOut, registerSync, signOutPlan } from './signout';
import { createMemoryDraftStore, type LocalDraft } from './store';
import { createDraftSync } from './sync';

const HEAD = 'a'.repeat(40);
const d = (path: string, extra: Partial<LocalDraft> = {}): LocalDraft => ({
  user: 'ana',
  repoId: 9,
  path,
  content: 'x',
  baseSha: HEAD,
  updatedAt: 1,
  pending: false,
  server: { etag: '"1-abcdefgh"', updatedAt: 't' },
  ...extra,
});

describe('sign-out plan', () => {
  it('counts drafts that only exist on this device: never synced, changed since, or never sent', () => {
    expect(signOutPlan([d('a'), d('b')])).toEqual({ unsynced: 0 });
    expect(signOutPlan([d('a'), d('b', { pending: true })])).toEqual({ unsynced: 1 });
    expect(signOutPlan([d('a', { server: undefined, pending: true }), d('b', { server: undefined })])).toEqual({ unsynced: 2 });
    expect(signOutPlan([])).toEqual({ unsynced: 0 });
  });
});

describe('clearing on sign-out', () => {
  it('deletes all of the user (every repository) or only the synced ones, never other users', async () => {
    const store = createMemoryDraftStore();
    await store.put(d('a'));
    await store.put(d('b', { repoId: 10, pending: true }));
    await store.put(d('c', { user: 'bo' }));
    await clearUserDrafts('ana', store, { keepUnsynced: true });
    expect((await store.listUser('ana')).map((x) => x.path)).toEqual(['b']);
    await clearUserDrafts('ana', store);
    expect(await store.listUser('ana')).toEqual([]);
    expect((await store.listUser('bo')).map((x) => x.path)).toEqual(['c']);
  });
});

describe('preparing sign-out', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const gatewayWith = (put: DraftsGateway['put']): DraftsGateway => ({
    list: vi.fn(),
    get: vi.fn(),
    put,
    remove: vi.fn(),
    removeAll: vi.fn(),
  });
  const meta = { path: 'a.qmd', baseSha: HEAD, size: 1, updatedAt: 't', etag: '"2-abcdefgh"' };

  it('writes waiting drafts and sends them to the server first, so a fresh edit is not lost or warned about', async () => {
    const store = createMemoryDraftStore();
    const put = vi.fn().mockResolvedValue(meta);
    const sync = createDraftSync({ store, gateway: gatewayWith(put), user: 'ana', repoId: 9, device: 'd', server: () => true });
    const off = registerSync(sync);
    await sync.load();
    sync.edit('a.qmd', 'typed just now', HEAD);
    expect(await prepareSignOut('ana', store)).toEqual({ unsynced: 0 });
    expect(put).toHaveBeenCalledTimes(1);
    off();
  });

  it('warns when the server copy could not be written (sync off, conflict or failure)', async () => {
    const store = createMemoryDraftStore();
    const offSync = createDraftSync({ store, user: 'ana', repoId: 9, device: 'd', server: () => false });
    const off1 = registerSync(offSync);
    await offSync.load();
    offSync.edit('a.qmd', 'local only', HEAD);
    const conflict = vi.fn().mockRejectedValue(new DraftConflictError('c', null));
    const other = createDraftSync({ store, gateway: gatewayWith(conflict), user: 'ana', repoId: 10, device: 'd', server: () => true });
    const off2 = registerSync(other);
    await other.load();
    other.edit('b.qmd', 'conflicted', HEAD);
    expect(await prepareSignOut('ana', store)).toEqual({ unsynced: 2 });
    off1();
    off2();
  });
});

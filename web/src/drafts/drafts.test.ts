import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFetch, json, on } from '../test/fakeFetch';
import { AuthRequiredError } from '../domain';
import { createHttpDraftsGateway, DraftConflictError, type DraftMeta, type DraftsGateway, type ServerDraft } from './http';
import { createMemoryDraftStore, type LocalDraft } from './store';
import { bufferChanges, createDraftSync, deviceLabel } from './sync';
import { planRestore, restoreBuffer } from './restore';

const API = 'https://api.example';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const ETAG = '"1730000000000-abcdefgh"';
const ETAG2 = '"1730000005000-zyxwvuts"';

const meta = (path: string, etag = ETAG, extra: Partial<DraftMeta> = {}): DraftMeta => ({
  path,
  baseSha: HEAD,
  device: 'Firefox on Linux',
  size: 3,
  updatedAt: '2026-10-28T10:00:00.000Z',
  etag,
  ...extra,
});
const wire = (m: DraftMeta) => ({
  path: m.path,
  base_sha: m.baseSha,
  device: m.device,
  size: m.size,
  updated_at: m.updatedAt,
  etag: m.etag,
});

describe('drafts gateway', () => {
  it('lists, gets, puts with If-Match, deletes one and all, with cookie and CSRF', async () => {
    const f = fakeFetch([
      on('GET', `${API}/api/galley/repos/9/drafts`, () => json({ drafts: [wire(meta('a.qmd')), { path: 1 }] })),
      on('GET', `${API}/api/galley/repos/9/drafts/sections/intro%20one.qmd`, () =>
        json({ ...wire(meta('sections/intro one.qmd')), content: 'hey' }),
      ),
      on('PUT', `${API}/api/galley/repos/9/drafts/a.qmd`, () => json(wire(meta('a.qmd', ETAG2)), 200)),
      on('DELETE', `${API}/api/galley/repos/9/drafts/a.qmd`, () => new Response(null, { status: 204 })),
      on('DELETE', `${API}/api/galley/repos/9/drafts/gone.qmd`, () => json({ error: 'Not Found' }, 404)),
      on('DELETE', `${API}/api/galley/repos/9/drafts`, () => json({ deleted: 2 })),
    ]);
    const g = createHttpDraftsGateway({ apiBase: API, fetch: f.fetch });
    expect(await g.list(9)).toEqual([meta('a.qmd')]);
    const got = await g.get(9, 'sections/intro one.qmd');
    expect(got.content).toBe('hey');
    const put = await g.put(9, 'a.qmd', { baseSha: HEAD, device: 'Firefox on Linux', content: 'abc' }, ETAG);
    expect(put.etag).toBe(ETAG2);
    await g.remove(9, 'a.qmd');
    await g.remove(9, 'gone.qmd'); // already gone: fine
    expect(await g.removeAll(9)).toBe(2);

    const putReq = f.requests.find((r) => r.method === 'PUT');
    expect(putReq?.headers.get('If-Match')).toBe(ETAG);
    expect(putReq?.headers.get('X-Galley-CSRF')).toBe('1');
    expect(putReq?.body).toEqual({ base_sha: HEAD, device: 'Firefox on Linux', content: 'abc' });
    expect(f.requests.every((r) => r.credentials === 'include')).toBe(true);
    expect(f.requests.filter((r) => r.method === 'GET').every((r) => r.headers.get('X-Galley-CSRF') === null)).toBe(true);
  });

  it('a create sends no If-Match; 409 carries the current metadata or null', async () => {
    let current: unknown = wire(meta('a.qmd', ETAG2));
    const f = fakeFetch([on('PUT', `${API}/api/galley/repos/9/drafts/a.qmd`, () => json({ error: 'Conflict', current }, 409))]);
    const g = createHttpDraftsGateway({ apiBase: API, fetch: f.fetch });
    const err = await g.put(9, 'a.qmd', { baseSha: HEAD, device: 'd', content: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DraftConflictError);
    expect((err as DraftConflictError).current?.etag).toBe(ETAG2);
    expect(f.requests[0]?.headers.get('If-Match')).toBeNull();
    current = null;
    const err2 = await g.put(9, 'a.qmd', { baseSha: HEAD, device: 'd', content: 'x' }, ETAG).catch((e: unknown) => e);
    expect((err2 as DraftConflictError).current).toBeNull();
  });

  it('maps 401 to sign in again and rejects malformed paths', async () => {
    const f = fakeFetch([on('GET', `${API}/api/galley/repos/9/drafts`, () => json({ error: 'Unauthorized' }, 401))]);
    const g = createHttpDraftsGateway({ apiBase: API, fetch: f.fetch });
    await expect(g.list(9)).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(g.get(9, '../x')).rejects.toThrow();
    await expect(g.get(9, '/abs')).rejects.toThrow();
  });
});

/** An in-memory drafts server with the API's precondition rules. */
function fakeServer() {
  const drafts = new Map<string, ServerDraft>();
  let n = 0;
  const calls: { op: string; path?: string; etag?: string; content?: string }[] = [];
  const next = (path: string, content: string, baseSha: string, device: string): ServerDraft => ({
    path,
    baseSha,
    device,
    size: content.length,
    updatedAt: new Date(Date.UTC(2026, 9, 28, 10, 0, ++n)).toISOString(),
    etag: `"${1730000000000 + n}-nonce${String(n).padStart(3, '0')}"`,
    content,
  });
  const strip = (d: ServerDraft): DraftMeta => {
    const m: Partial<ServerDraft> = { ...d };
    delete m.content;
    return m as DraftMeta;
  };
  const gateway: DraftsGateway = {
    async list() {
      calls.push({ op: 'list' });
      return [...drafts.values()].map(strip);
    },
    async get(_repo, path) {
      calls.push({ op: 'get', path });
      const d = drafts.get(path);
      if (!d) throw new Error('404');
      return d;
    },
    async put(_repo, path, input, etag) {
      calls.push({ op: 'put', path, etag, content: input.content });
      const cur = drafts.get(path);
      if (etag === undefined ? cur !== undefined : cur?.etag !== etag) throw new DraftConflictError('conflict', cur ? strip(cur) : null);
      const d = next(path, input.content, input.baseSha, input.device);
      drafts.set(path, d);
      return strip(d);
    },
    async remove(_repo, path) {
      calls.push({ op: 'remove', path });
      drafts.delete(path);
    },
    async removeAll() {
      calls.push({ op: 'removeAll' });
      const k = drafts.size;
      drafts.clear();
      return k;
    },
  };
  /** Another device writes the draft. */
  const otherDevice = (path: string, content: string) => drafts.set(path, next(path, content, HEAD, 'Safari on iPhone'));
  return { gateway, drafts, calls, otherDevice };
}

describe('draft sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = (serverOn = true) => {
    const store = createMemoryDraftStore();
    const server = fakeServer();
    const conflicts: string[] = [];
    let on = serverOn;
    const sync = createDraftSync({
      store,
      gateway: server.gateway,
      user: 'ana',
      repoId: 9,
      device: 'Chrome on Linux',
      server: () => on,
      onConflict: (path) => conflicts.push(path),
    });
    return { store, server, sync, conflicts, setServer: (v: boolean) => (on = v) };
  };

  it('writes the local draft about 1 s after typing stops, keyed by user, repo and path', async () => {
    const { store, sync } = setup(false);
    await sync.load();
    sync.edit('a.qmd', 'h', HEAD);
    await vi.advanceTimersByTimeAsync(500);
    sync.edit('a.qmd', 'he', HEAD);
    await vi.advanceTimersByTimeAsync(900);
    expect(await store.get('ana', 9, 'a.qmd')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    const d = await store.get('ana', 9, 'a.qmd');
    expect(d?.content).toBe('he');
    expect(d?.baseSha).toBe(HEAD);
    expect(await store.get('bo', 9, 'a.qmd')).toBeUndefined();
    expect(sync.state().savedAt).toBeTypeOf('number');
  });

  it('syncs to the server debounced about 5 s, only when the content changed, with If-Match after the first write', async () => {
    const { server, sync } = setup();
    await sync.load();
    sync.edit('a.qmd', 'one', HEAD);
    await vi.advanceTimersByTimeAsync(4000);
    expect(server.calls.filter((c) => c.op === 'put')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    const puts = () => server.calls.filter((c) => c.op === 'put');
    expect(puts()).toEqual([{ op: 'put', path: 'a.qmd', etag: undefined, content: 'one' }]);
    // Same content again: nothing to send.
    sync.edit('a.qmd', 'one', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(puts()).toHaveLength(1);
    sync.edit('a.qmd', 'two', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(puts()).toHaveLength(2);
    expect(puts()[1]?.etag).toMatch(/^"\d+-nonce001"$/);
    expect(server.drafts.get('a.qmd')?.content).toBe('two');
  });

  it('409: reports a newer draft from another device and never overwrites either copy', async () => {
    const { server, sync, store, conflicts } = setup();
    await sync.load();
    sync.edit('a.qmd', 'mine', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    server.otherDevice('a.qmd', 'theirs');
    sync.edit('a.qmd', 'mine 2', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(conflicts).toEqual(['a.qmd']);
    expect(sync.state().conflicts).toEqual([{ path: 'a.qmd', current: expect.objectContaining({ device: 'Safari on iPhone' }) }]);
    expect(server.drafts.get('a.qmd')?.content).toBe('theirs');
    expect((await store.get('ana', 9, 'a.qmd'))?.content).toBe('mine 2');
    // Further typing keeps the local copy but does not retry the server while the choice is open.
    sync.edit('a.qmd', 'mine 3', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(server.drafts.get('a.qmd')?.content).toBe('theirs');
    expect((await store.get('ana', 9, 'a.qmd'))?.content).toBe('mine 3');
  });

  it('Keep mine replaces the server copy against the version shown; Use it adopts the server copy', async () => {
    const { server, sync, store } = setup();
    await sync.load();
    server.otherDevice('a.qmd', 'theirs');
    sync.edit('a.qmd', 'mine', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(sync.state().conflicts).toHaveLength(1);
    const shown = sync.state().conflicts[0]?.current?.etag;
    await sync.keepMine('a.qmd');
    expect(server.calls.at(-1)).toMatchObject({ op: 'put', etag: shown, content: 'mine' });
    expect(server.drafts.get('a.qmd')?.content).toBe('mine');
    expect(sync.state().conflicts).toEqual([]);

    server.otherDevice('a.qmd', 'newest');
    sync.edit('a.qmd', 'mine again', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    const theirs = await sync.useTheirs('a.qmd');
    expect(theirs?.content).toBe('newest');
    expect((await store.get('ana', 9, 'a.qmd'))?.content).toBe('newest');
    expect(sync.state().conflicts).toEqual([]);
    // Typing the adopted text back is not a change.
    const before = server.calls.length;
    sync.edit('a.qmd', 'newest', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(server.calls.length).toBe(before);
  });

  it('Keep mine when the other draft was deleted creates it again', async () => {
    const { server, sync } = setup();
    await sync.load();
    sync.edit('a.qmd', 'mine', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    server.drafts.delete('a.qmd');
    sync.edit('a.qmd', 'mine 2', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(sync.state().conflicts).toEqual([{ path: 'a.qmd', current: null }]);
    await sync.keepMine('a.qmd');
    expect(server.calls.at(-1)).toMatchObject({ op: 'put', etag: undefined });
    expect(server.drafts.get('a.qmd')?.content).toBe('mine 2');
  });

  it('discard (after a save, or Undo) deletes the local and the server draft', async () => {
    const { server, sync, store } = setup();
    await sync.load();
    sync.edit('a.qmd', 'x', HEAD);
    sync.edit('b.qmd', 'y', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(server.drafts.size).toBe(2);
    await sync.discard('a.qmd');
    expect(await store.get('ana', 9, 'a.qmd')).toBeUndefined();
    expect(server.drafts.has('a.qmd')).toBe(false);
    expect(server.drafts.has('b.qmd')).toBe(true);
    // A pending edit is cancelled too.
    sync.edit('b.qmd', 'y2', HEAD);
    await sync.discard('b.qmd');
    await vi.advanceTimersByTimeAsync(7000);
    expect(await store.get('ana', 9, 'b.qmd')).toBeUndefined();
    expect(server.drafts.size).toBe(0);
  });

  it('with server drafts off it stays local; turning them off deletes the server copies', async () => {
    const { server, sync, store, setServer } = setup();
    await sync.load();
    sync.edit('a.qmd', 'x', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(server.drafts.size).toBe(1);
    setServer(false);
    await sync.disableServer();
    expect(server.calls.at(-1)?.op).toBe('removeAll');
    sync.edit('a.qmd', 'x2', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(server.drafts.size).toBe(0);
    expect((await store.get('ana', 9, 'a.qmd'))?.content).toBe('x2');
    expect((await store.get('ana', 9, 'a.qmd'))?.server).toBeUndefined();
  });

  it('stops talking to the server after 401, keeping the local draft', async () => {
    const store = createMemoryDraftStore();
    const put = vi.fn().mockRejectedValue(new AuthRequiredError('sign in'));
    const gateway = { list: vi.fn(), get: vi.fn(), put, remove: vi.fn(), removeAll: vi.fn() } as unknown as DraftsGateway;
    const sync = createDraftSync({ store, gateway, user: 'ana', repoId: 9, device: 'd', server: () => true });
    await sync.load();
    sync.edit('a.qmd', 'x', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    sync.edit('a.qmd', 'y', HEAD);
    await vi.advanceTimersByTimeAsync(7000);
    expect(put).toHaveBeenCalledTimes(1);
    expect((await store.get('ana', 9, 'a.qmd'))?.content).toBe('y');
  });
});

describe('buffer changes', () => {
  it('edits come from dirty buffers; a tracked buffer that became clean (saved or undone) clears its draft', () => {
    const tracked = new Set<string>();
    const first = bufferChanges(tracked, { 'a.qmd': { base: 'a', text: 'a!' }, 'b.qmd': { base: 'b', text: 'b' } });
    expect(first).toEqual({ edits: [{ path: 'a.qmd', text: 'a!' }], clears: [] });
    // After a save: a.qmd's base is the saved text.
    const second = bufferChanges(tracked, { 'a.qmd': { base: 'a!', text: 'a!' }, 'b.qmd': { base: 'b', text: 'b' } });
    expect(second).toEqual({ edits: [], clears: ['a.qmd'] });
    expect(tracked.size).toBe(0);
    // Buffers with an open merge choice are not drafted.
    const merging = bufferChanges(tracked, { 'c.qmd': { base: 'c', text: 'c!', merge: { base: 'c0', regions: [] } } });
    expect(merging).toEqual({ edits: [], clears: [] });
    // A clean buffer never seen dirty keeps its (restorable) draft.
    expect(bufferChanges(new Set(), { 'd.qmd': { base: 'd', text: 'd' } }).clears).toEqual([]);
  });

  it('names the device from the user agent', () => {
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox on Linux');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe(
      'Safari on iPhone',
    );
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows');
    expect(deviceLabel('')).toBe('Browser');
  });
});

describe('restore', () => {
  const local = (path: string, content: string, extra: Partial<LocalDraft> = {}): LocalDraft => ({
    user: 'ana',
    repoId: 9,
    path,
    content,
    baseSha: HEAD,
    updatedAt: 1,
    pending: false,
    ...extra,
  });

  it('same base: the draft becomes the buffer over the current text', async () => {
    const read = vi.fn();
    expect(await restoreBuffer({ content: 'mine', baseSha: HEAD }, { text: 'repo', headSha: HEAD }, read)).toEqual({
      kind: 'same',
      buffer: { base: 'repo', text: 'mine' },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('a draft equal to the current text restores nothing', async () => {
    expect(await restoreBuffer({ content: 'repo', baseSha: OLD }, { text: 'repo', headSha: HEAD }, vi.fn())).toEqual({ kind: 'none' });
  });

  it('another base: reads it by SHA and merges three ways (clean)', async () => {
    const read = vi.fn().mockResolvedValue('one\ntwo\nthree\nfour\n');
    const out = await restoreBuffer(
      { content: 'one\ntwo (mine)\nthree\nfour\n', baseSha: OLD },
      { text: 'one\ntwo\nthree\nfour (theirs)\n', headSha: HEAD },
      read,
    );
    expect(read).toHaveBeenCalledWith(OLD);
    expect(out).toEqual({
      kind: 'merged',
      buffer: { base: 'one\ntwo\nthree\nfour (theirs)\n', text: 'one\ntwo (mine)\nthree\nfour (theirs)\n' },
    });
  });

  it('another base: same lines changed opens the conflict choice (mine kept)', async () => {
    const out = await restoreBuffer({ content: 'a\nMINE\n', baseSha: OLD }, { text: 'a\nTHEIRS\n', headSha: HEAD }, async () => 'a\nb\n');
    expect(out.kind).toBe('conflict');
    if (out.kind !== 'conflict') return;
    expect(out.buffer.text).toBe('a\nMINE\n');
    expect(out.buffer.base).toBe('a\nTHEIRS\n');
    expect(out.buffer.merge?.base).toBe('a\nb\n');
    expect(out.buffer.merge?.regions.some((r) => r.kind === 'conflict')).toBe(true);
  });

  it('an unreadable base never overwrites: everything becomes a choice', async () => {
    const out = await restoreBuffer({ content: 'MINE\n', baseSha: OLD }, { text: 'THEIRS\n', headSha: HEAD }, () => Promise.reject(new Error('404')));
    expect(out.kind).toBe('conflict');
  });

  it('plans: local drafts restore; unknown server drafts are offered; a different server version is a conflict', () => {
    const plan = planRestore(
      [local('a.qmd', 'x', { server: { etag: ETAG, updatedAt: 't' } }), local('b.qmd', 'y', { server: { etag: ETAG, updatedAt: 't' } }), local('c.qmd', 'z')],
      [meta('a.qmd', ETAG), meta('b.qmd', ETAG2), meta('d.qmd', ETAG)],
    );
    expect(plan.local.map((d) => d.path)).toEqual(['a.qmd', 'b.qmd', 'c.qmd']);
    expect(plan.offer.map((d) => d.path)).toEqual(['d.qmd']);
    expect(plan.conflicts).toEqual([{ path: 'b.qmd', current: meta('b.qmd', ETAG2) }]);
  });
});

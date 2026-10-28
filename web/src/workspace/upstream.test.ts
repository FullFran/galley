import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  TransientError,
  type BringInResult,
  type FileChange,
  type RepoGateway,
  type Repository,
  type UpstreamStatus,
} from '../domain';
import type { Buffer, Buffers } from './model';
import { bringIn, createUpstreamWatcher, rebase, saveWithUpstream, shouldOffer, unresolvedPaths, upstreamBases } from './upstream';

const repo: Repository = { id: 1, owner: 'o', name: 'paper', fullName: 'o/paper', defaultBranch: 'main', private: true };

describe('upstream watcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(heads: string[], behind = 2, visible = true) {
    let i = 0;
    const defaultHead = vi.fn(async () => heads[Math.min(i++, heads.length - 1)] as string);
    const upstream = vi.fn(async (): Promise<UpstreamStatus> => ({ defaultHead: heads[Math.min(i - 1, heads.length - 1)] as string, behind }));
    const onStatus = vi.fn();
    const events = new EventTarget();
    const watcher = createUpstreamWatcher({ defaultHead, upstream, onStatus, intervalMs: 60_000, visible: () => visible, events });
    return { watcher, defaultHead, upstream, onStatus, events };
  }

  it('checks on start, then polls the default head every interval and compares only when it moved', async () => {
    const { watcher, defaultHead, upstream, onStatus } = setup(['m1', 'm1', 'm2']);
    watcher.start('w1');
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith({ defaultHead: 'm1', behind: 2 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(defaultHead).toHaveBeenCalledTimes(2);
    expect(upstream).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(upstream).toHaveBeenLastCalledWith('w1');
    watcher.dispose();
  });

  it('does not poll while the tab is hidden', async () => {
    const { watcher, defaultHead } = setup(['m1'], 1, false);
    watcher.start('w1');
    await vi.advanceTimersByTimeAsync(180_000);
    expect(defaultHead).toHaveBeenCalledTimes(0);
    watcher.dispose();
  });

  it('checks again on window focus and after the working head changes', async () => {
    const { watcher, upstream, events } = setup(['m1']);
    watcher.start('w1');
    await vi.advanceTimersByTimeAsync(0);
    watcher.setHead('w2');
    await vi.advanceTimersByTimeAsync(0);
    expect(upstream).toHaveBeenLastCalledWith('w2');
    events.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    // Same default head and same working head: no new compare.
    expect(upstream).toHaveBeenCalledTimes(2);
    watcher.dispose();
  });

  it('stops polling after dispose and swallows failures', async () => {
    const defaultHead = vi.fn(async () => {
      throw new Error('offline');
    });
    const watcher = createUpstreamWatcher({
      defaultHead,
      upstream: vi.fn(),
      onStatus: vi.fn(),
      intervalMs: 1000,
      visible: () => true,
      events: new EventTarget(),
    });
    watcher.start('w1');
    await vi.advanceTimersByTimeAsync(0);
    watcher.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(defaultHead).toHaveBeenCalledTimes(1);
  });
});

describe('the bring-in prompt', () => {
  it('shows while the default branch has new changes, until dismissed for that head', () => {
    expect(shouldOffer({ defaultHead: 'm2', behind: 3 }, undefined)).toBe(true);
    expect(shouldOffer({ defaultHead: 'm2', behind: 0 }, undefined)).toBe(false);
    expect(shouldOffer(undefined, undefined)).toBe(false);
    expect(shouldOffer({ defaultHead: 'm2', behind: 3 }, 'm2')).toBe(false);
    // The default branch moved again after the dismissal: offer again.
    expect(shouldOffer({ defaultHead: 'm3', behind: 4 }, 'm2')).toBe(true);
  });
});

describe('rebasing buffers on the new head', () => {
  const before: Buffers = {
    'clean.qmd': { base: 'c\n', text: 'c\n' },
    'same.qmd': { base: 's\n', text: 's\n' },
    'dirty.qmd': { base: 'one\ntwo\nthree\nfour\n', text: 'one (mine)\ntwo\nthree\nfour\n' },
    'clash.qmd': { base: 'one\n', text: 'one (mine)\n' },
    'dirty-untouched.qmd': { base: 'u\n', text: 'mine too\n' },
    'gone.qmd': { base: 'g\n', text: 'g\n' },
  };
  const upstreamText: Record<string, string> = {
    'clean.qmd': 'c2\n',
    'same.qmd': 's\n',
    'dirty.qmd': 'one\ntwo\nthree\nfour (main)\n',
    'clash.qmd': 'one (main)\n',
    'dirty-untouched.qmd': 'u\n',
  };
  const read = async (path: string) => {
    const text = upstreamText[path];
    if (text === undefined) throw new NotFoundError(path);
    return text;
  };

  it('finds the open files whose text changed upstream', async () => {
    const { bases } = await upstreamBases(before, read);
    expect(bases).toEqual({
      'clean.qmd': 'c2\n',
      'dirty.qmd': 'one\ntwo\nthree\nfour (main)\n',
      'clash.qmd': 'one (main)\n',
      'gone.qmd': undefined,
    });
  });

  it('refreshes clean files and merges main into edited ones (three-way), never dropping a change', async () => {
    const { bases } = await upstreamBases(before, read);
    const { buffers, merged, conflicted } = rebase(before, bases, before);
    expect(buffers['clean.qmd']).toEqual({ base: 'c2\n', text: 'c2\n' });
    expect(buffers['dirty.qmd']).toEqual({ base: 'one\ntwo\nthree\nfour (main)\n', text: 'one (mine)\ntwo\nthree\nfour (main)\n' });
    expect(buffers['dirty-untouched.qmd']).toEqual(before['dirty-untouched.qmd']);
    expect(buffers['gone.qmd']).toBeUndefined();
    expect(merged).toEqual(['dirty.qmd']);
    expect(conflicted).toEqual(['clash.qmd']);
  });

  it('keeps the user text of a conflicting file and the regions to choose from', async () => {
    const { bases } = await upstreamBases(before, read);
    const clash = rebase(before, bases, before).buffers['clash.qmd'];
    expect(clash?.text).toBe('one (mine)\n');
    expect(clash?.base).toBe('one (main)\n');
    expect(clash?.merge?.regions).toEqual([{ kind: 'conflict', yours: 'one (mine)\n', theirs: 'one (main)\n' }]);
    expect(unresolvedPaths({ 'clash.qmd': clash as Buffer })).toEqual(['clash.qmd']);
  });

  it('treats a file typed into during the fetch as edited, using the base from before', () => {
    const snapshot: Buffers = { 'a.qmd': { base: 'x\n', text: 'x\n' } };
    const typed: Buffers = { 'a.qmd': { base: 'x\n', text: 'x\ny (typed meanwhile)\n' } };
    const { buffers, merged } = rebase(typed, { 'a.qmd': 'w (main)\nx\n' }, snapshot);
    expect(buffers['a.qmd']).toEqual({ base: 'w (main)\nx\n', text: 'w (main)\nx\ny (typed meanwhile)\n' });
    expect(merged).toEqual(['a.qmd']);
  });

  it('merges against the original base when a conflict is still open and main moves again', () => {
    const pending: Buffers = {
      'a.qmd': { base: 'one (main)\n', text: 'one (mine)\n', merge: { base: 'one\n', regions: [] } },
    };
    const { buffers, conflicted } = rebase(pending, { 'a.qmd': 'one (main 2)\n' }, pending);
    expect(conflicted).toEqual(['a.qmd']);
    expect(buffers['a.qmd']?.merge).toEqual({ base: 'one\n', regions: [{ kind: 'conflict', yours: 'one (mine)\n', theirs: 'one (main 2)\n' }] });
  });
});

function fakeGateway(bring: () => Promise<BringInResult>, files: Record<string, string> = {}, saveFails?: Error) {
  const log: string[] = [];
  const gateway: RepoGateway = {
    listRepositories: () => Promise.resolve([]),
    openRepository: () => Promise.reject(new Error('unused')),
    defaultHead: () => Promise.reject(new Error('unused')),
    upstream: () => Promise.reject(new Error('unused')),
    bringInDefault: async (_repo, head) => {
      log.push(`bring ${head}`);
      return bring();
    },
    readFile: async (_repo, path, ref) => {
      const text = files[`${ref}:${path}`];
      if (text === undefined) throw new NotFoundError(path);
      return text;
    },
    readBytes: () => Promise.reject(new Error('unused')),
    save: async (_repo, changes: FileChange[], _message, head) => {
      log.push(`save ${head} ${changes.map((c) => `${c.path}=${JSON.stringify(c.content)}`).join(',')}`);
      if (saveFails) throw saveFails;
      return { commitSha: 'c9', pullRequestUrl: 'u' };
    },
  };
  return { gateway, log };
}

const updated = async (): Promise<BringInResult> => ({ kind: 'updated', headSha: 'mg', files: ['a.qmd', 'b.qmd'], truncated: false, blobs: {} });

describe('"Bring them in"', () => {
  const snapshot: Buffers = {
    'a.qmd': { base: 'one\ntwo\nthree\n', text: 'one (mine)\ntwo\nthree\n' },
    'b.qmd': { base: 'b\n', text: 'b (mine)\n' },
  };

  it('reads the new head and three-way merges edited files, like a save does', async () => {
    const { gateway, log } = fakeGateway(updated, { 'mg:a.qmd': 'one\ntwo\nthree (main)\n', 'mg:b.qmd': 'b (main)\n' });
    const out = await bringIn(gateway, repo, 'w1', snapshot);
    expect(log).toEqual(['bring w1']);
    expect(out.kind).toBe('updated');
    if (out.kind !== 'updated') return;
    const { buffers, merged, conflicted } = rebase(snapshot, out.upstream.bases, out.upstream.before);
    expect(merged).toEqual(['a.qmd']);
    expect(conflicted).toEqual(['b.qmd']);
    expect(buffers['a.qmd']?.text).toBe('one (mine)\ntwo\nthree (main)\n');
  });

  it('passes through nothing to do and conflicts on GitHub', async () => {
    await expect(bringIn(fakeGateway(async () => ({ kind: 'current' })).gateway, repo, 'w1', snapshot)).resolves.toEqual({ kind: 'current' });
    await expect(bringIn(fakeGateway(async () => ({ kind: 'conflict' })).gateway, repo, 'w1', snapshot)).resolves.toEqual({ kind: 'conflict' });
  });
});

describe('saving with the default branch brought in first', () => {
  const edited: Buffers = { 'a.qmd': { base: 'a\n', text: 'a edited\n' }, 'b.qmd': { base: 'b\n', text: 'b\n' } };

  it('merges the default branch before the commit and saves on the new head', async () => {
    const { gateway, log } = fakeGateway(updated, { 'mg:a.qmd': 'a\n', 'mg:b.qmd': 'b from main\n' });
    const out = await saveWithUpstream(gateway, repo, edited, 'Edit', 'w1');
    expect(log).toEqual(['bring w1', 'save mg a.qmd="a edited\\n"']);
    expect(out).toMatchObject({ kind: 'saved', headSha: 'c9', upstream: { headSha: 'mg', bases: { 'b.qmd': 'b from main\n' } } });
  });

  it('saves the three-way merged text when main changed other lines of an edited file', async () => {
    // Changes at least one unchanged line apart (adjacent changes conflict, as in git).
    const both: Buffers = { 'a.qmd': { base: 'one\ntwo\nthree\n', text: 'one (mine)\ntwo\nthree\n' } };
    const { gateway, log } = fakeGateway(updated, { 'mg:a.qmd': 'one\ntwo\nthree (main)\n' });
    const out = await saveWithUpstream(gateway, repo, both, 'Edit', 'w1');
    expect(log).toEqual(['bring w1', 'save mg a.qmd="one (mine)\\ntwo\\nthree (main)\\n"']);
    expect(out).toMatchObject({ kind: 'saved', merged: ['a.qmd'] });
  });

  it('saves on the same head when there is nothing to bring in', async () => {
    const { gateway, log } = fakeGateway(async () => ({ kind: 'current' }));
    const out = await saveWithUpstream(gateway, repo, edited, 'Edit', 'w1');
    expect(log).toEqual(['bring w1', 'save w1 a.qmd="a edited\\n"']);
    expect(out).toMatchObject({ kind: 'saved' });
    expect((out as { upstream?: unknown }).upstream).toBeUndefined();
  });

  it('stops the save on a merge conflict on GitHub and commits nothing', async () => {
    const { gateway, log } = fakeGateway(async () => ({ kind: 'conflict' }));
    await expect(saveWithUpstream(gateway, repo, edited, 'Edit', 'w1')).resolves.toEqual({ kind: 'upstream-conflict' });
    expect(log).toEqual(['bring w1']);
  });

  it('stops before committing when main changed the same lines the user edited', async () => {
    const { gateway, log } = fakeGateway(updated, { 'mg:a.qmd': 'a from main\n', 'mg:b.qmd': 'b\n' });
    const out = await saveWithUpstream(gateway, repo, edited, 'Edit', 'w1');
    expect(log).toEqual(['bring w1']);
    expect(out).toMatchObject({ kind: 'upstream-conflicted', paths: ['a.qmd'], upstream: { headSha: 'mg' } });
  });

  it('refuses to save while a file still has conflicts to resolve, without calling GitHub', async () => {
    const { gateway, log } = fakeGateway(updated);
    const pending: Buffers = {
      'a.qmd': { base: 'x\n', text: 'y\n', merge: { base: 'w\n', regions: [{ kind: 'conflict', yours: 'y\n', theirs: 'x\n' }] } },
    };
    await expect(saveWithUpstream(gateway, repo, pending, 'Edit', 'w1')).resolves.toEqual({ kind: 'unresolved', paths: ['a.qmd'] });
    expect(log).toEqual([]);
  });

  it('keeps the merged head when the commit fails after the merge', async () => {
    const { gateway } = fakeGateway(updated, { 'mg:a.qmd': 'a\n', 'mg:b.qmd': 'b\n' }, new TransientError('offline'));
    const out = await saveWithUpstream(gateway, repo, edited, 'Edit', 'w1');
    expect(out).toMatchObject({ kind: 'error', upstream: { headSha: 'mg' } });
  });

  it('reports a working branch that moved as a save conflict that keeps copies', async () => {
    const { gateway } = fakeGateway(async () => {
      throw new ConflictError('moved');
    });
    await expect(saveWithUpstream(gateway, repo, edited, 'Edit', 'w1')).resolves.toEqual({
      kind: 'conflict',
      copies: [{ path: 'a.qmd', content: 'a edited\n' }],
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ChangedFile } from '../domain';
import { applyRestore, fileRestoreOps, planRestore, prepareRestore, type RestoreChange } from './restore';

const file = (path: string, status: string, previousPath?: string): ChangedFile => ({ path, status, additions: 1, deletions: 1, previousPath });

describe('restoring a version', () => {
  it('plans writes for changed and missing files and deletions for files the version did not have', () => {
    const old = { 'a.qmd': 'b1', 'b.qmd': 'b2', 'gone.qmd': 'b3' };
    const head = { 'a.qmd': 'b1', 'b.qmd': 'B2', 'new.qmd': 'b4' };
    expect(planRestore(old, head, [])).toEqual([
      { path: 'b.qmd', op: 'write' },
      { path: 'gone.qmd', op: 'write' },
      { path: 'new.qmd', op: 'delete' },
    ]);
  });

  it('also resets unsaved edits of files the version has unchanged', () => {
    expect(planRestore({ 'a.qmd': 'b1' }, { 'a.qmd': 'b1' }, ['a.qmd', 'draft.qmd'])).toEqual([
      { path: 'a.qmd', op: 'write' },
      { path: 'draft.qmd', op: 'delete' },
    ]);
  });

  it('restores one file from a comparison with the current version', () => {
    expect(fileRestoreOps(file('a.qmd', 'modified'))).toEqual([{ path: 'a.qmd', op: 'write' }]);
    expect(fileRestoreOps(file('a.qmd', 'removed'))).toEqual([{ path: 'a.qmd', op: 'write' }]);
    expect(fileRestoreOps(file('a.qmd', 'added'))).toEqual([{ path: 'a.qmd', op: 'delete' }]);
    expect(fileRestoreOps(file('new.qmd', 'renamed', 'old.qmd'))).toEqual([
      { path: 'old.qmd', op: 'write' },
      { path: 'new.qmd', op: 'delete' },
    ]);
  });

  it('reads the current text as the base of files that are not open yet', async () => {
    const read = vi.fn(async (path: string) => `head ${path}`);
    const changes: RestoreChange[] = [
      { path: 'open.qmd', kind: 'text', text: 'old open' },
      { path: 'closed.qmd', kind: 'text', text: 'old closed' },
      { path: 'deleted-since.qmd', kind: 'text', text: 'old deleted' },
    ];
    const prepared = await prepareRestore(changes, { 'open.qmd': { base: 'b', text: 'mine' } }, ['open.qmd', 'closed.qmd'], read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith('closed.qmd');
    expect(prepared).toEqual([
      { path: 'open.qmd', kind: 'text', text: 'old open', base: 'b' },
      { path: 'closed.qmd', kind: 'text', text: 'old closed', base: 'head closed.qmd' },
      { path: 'deleted-since.qmd', kind: 'text', text: 'old deleted', base: '' },
    ]);
  });

  it('turns restored files into unsaved buffers and pending changes, never a commit', () => {
    const result = applyRestore(
      { 'a.qmd': { base: 'now', text: 'now' }, 'b.qmd': { base: 'b', text: 'edited' } },
      [{ path: 'fig.png', content: 'AAA', encoding: 'base64' }],
      [
        { path: 'a.qmd', kind: 'text', text: 'then', base: 'now' },
        { path: 'b.qmd', kind: 'delete' },
        { path: 'fig.png', kind: 'bytes', base64: 'QkJC' },
        { path: 'back.qmd', kind: 'text', text: 'back', base: '' },
      ],
      ['a.qmd', 'b.qmd', 'fig.png'],
    );
    expect(result.buffers).toEqual({ 'a.qmd': { base: 'now', text: 'then' }, 'back.qmd': { base: '', text: 'back' } });
    expect(result.pending).toEqual([
      { path: 'fig.png', content: 'QkJC', encoding: 'base64' },
      { path: 'b.qmd', content: '', delete: true },
    ]);
    expect(result.created).toEqual(['back.qmd']);
    expect(result.deleted).toEqual(['b.qmd']);
  });

  it('drops a pending deletion when the file is restored again, and ignores deleting a file that does not exist', () => {
    const result = applyRestore(
      {},
      [{ path: 'b.qmd', content: '', delete: true }],
      [
        { path: 'b.qmd', kind: 'text', text: 'again', base: 'head' },
        { path: 'never.qmd', kind: 'delete' },
      ],
      ['b.qmd'],
    );
    expect(result.pending).toEqual([]);
    expect(result.buffers['b.qmd']).toEqual({ base: 'head', text: 'again' });
    expect(result.deleted).toEqual([]);
  });

  it('clears a conflict choice when a file is restored', () => {
    const result = applyRestore(
      { 'a.qmd': { base: 'x', text: 'y', merge: { base: 'w', regions: [] } } },
      [],
      [{ path: 'a.qmd', kind: 'text', text: 'old', base: 'x' }],
      ['a.qmd'],
    );
    expect(result.buffers['a.qmd']).toEqual({ base: 'x', text: 'old' });
  });
});

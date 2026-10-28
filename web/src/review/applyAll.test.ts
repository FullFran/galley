import { describe, expect, it, vi } from 'vitest';
import { ConflictError, PermissionError, type Proposal, type RepoAccess, type ReviewComment } from '../domain';
import { applyAllSuggestions, applyAllSummary, openSuggestions } from './applyAll';
import { en } from '../i18n/en';

const proposal: Proposal = {
  number: 4,
  title: 't',
  updatedAt: '',
  draft: false,
  body: '',
  state: 'open',
  headSha: 'h1',
  headBranch: 'galley/ana',
  sameRepo: true,
  baseBranch: 'main',
  mergeable: true,
  mergeableState: 'clean',
  requestedReviewers: [],
  assignees: [],
};
const access: RepoAccess = { canPush: true, admin: false, mergeMethods: [] };
const repo = { id: 1, owner: 'o', name: 'p', fullName: 'o/p', defaultBranch: 'main', private: true };

const PAPER = 'one\ntwo\nthree\nfour\nfive\n';
const NOTES = 'alpha\nbeta\n';

let nextId = 1;
function suggestion(path: string, line: number, expected: string, replacement: string, login = 'dir', extra: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: nextId++,
    author: { login, id: login === 'dir' ? 77 : 88 },
    body: `Try:\n\`\`\`suggestion\n${replacement}\n\`\`\``,
    path,
    line,
    startLine: null,
    side: 'RIGHT',
    diffHunk: `@@ -1 +1 @@\n+${expected}`,
    subjectType: 'line',
    createdAt: `2026-10-0${nextId}`,
    ...extra,
  };
}

function deps(texts: Record<string, string> = { 'paper.qmd': PAPER, 'notes.md': NOTES }) {
  return {
    repos: { readFile: vi.fn(async (_r: unknown, path: string) => texts[path] ?? '') },
    reviews: { commitToProposal: vi.fn(async () => 'c9') },
  };
}

describe('openSuggestions', () => {
  it('keeps suggestions on current lines in threads that are not resolved', () => {
    const a = suggestion('paper.qmd', 2, 'two', 'TWO');
    const resolved = suggestion('paper.qmd', 4, 'four', 'FOUR');
    const outdated = suggestion('paper.qmd', 5, 'five', 'FIVE', 'dir', { line: null });
    const plain = { ...suggestion('paper.qmd', 1, 'one', 'x'), body: 'just a remark' };
    const list = openSuggestions([a, resolved, outdated, plain], { [resolved.id]: { resolved: true } });
    expect(list.map((c) => c.id)).toEqual([a.id, outdated.id]);
  });
});

describe('applyAllSuggestions', () => {
  it('builds one commit with every suggestion that still matches, crediting each suggester once', async () => {
    const d = deps();
    const c1 = suggestion('paper.qmd', 2, 'two', 'TWO');
    const c2 = suggestion('paper.qmd', 4, 'four', 'FOUR\nand more', 'eve');
    const c3 = suggestion('notes.md', 1, 'alpha', 'ALPHA');
    const result = await applyAllSuggestions(d, repo, proposal, access, [c1, c2, c3]);

    expect(result.sha).toBe('c9');
    expect(result.applied.map((c) => c.id)).toEqual([c1.id, c2.id, c3.id]);
    expect(result.skipped).toEqual([]);
    expect(d.repos.readFile).toHaveBeenCalledTimes(2);
    expect(d.reviews.commitToProposal).toHaveBeenCalledTimes(1);
    expect(d.reviews.commitToProposal).toHaveBeenCalledWith(
      repo,
      proposal,
      [
        { path: 'paper.qmd', content: 'one\nTWO\nthree\nFOUR\nand more\nfive\n' },
        { path: 'notes.md', content: 'ALPHA\nbeta\n' },
      ],
      'Apply 3 suggestions\n\nCo-authored-by: dir <77+dir@users.noreply.github.com>\nCo-authored-by: eve <88+eve@users.noreply.github.com>',
      'h1',
    );
  });

  it('skips and reports suggestions that no longer match, overlap or are outdated', async () => {
    const d = deps({ 'paper.qmd': 'one\nchanged\nthree\nfour\nfive\n' });
    const stale = suggestion('paper.qmd', 2, 'two', 'TWO');
    const ok = suggestion('paper.qmd', 4, 'four', 'FOUR');
    const overlap = suggestion('paper.qmd', 4, 'four', 'Four?', 'eve');
    const outdated = suggestion('paper.qmd', 5, 'five', 'FIVE', 'dir', { line: null });
    const result = await applyAllSuggestions(d, repo, proposal, access, [stale, ok, overlap, outdated]);

    expect(result.applied.map((c) => c.id)).toEqual([ok.id]);
    expect(result.skipped.map((s) => [s.comment.id, s.reason])).toEqual([
      [stale.id, 'changed'],
      [overlap.id, 'overlap'],
      [outdated.id, 'outdated'],
    ]);
    const [, , changes, message] = d.reviews.commitToProposal.mock.calls[0] as unknown as [unknown, unknown, unknown, string];
    expect(changes).toEqual([{ path: 'paper.qmd', content: 'one\nchanged\nthree\nFOUR\nfive\n' }]);
    expect(message).toBe('Apply suggestion\n\nCo-authored-by: dir <77+dir@users.noreply.github.com>');
  });

  it('makes no commit when nothing applies', async () => {
    const d = deps({ 'paper.qmd': 'rewritten\n' });
    const result = await applyAllSuggestions(d, repo, proposal, access, [suggestion('paper.qmd', 1, 'one', 'x')]);
    expect(result.sha).toBeUndefined();
    expect(result.skipped).toHaveLength(1);
    expect(d.reviews.commitToProposal).not.toHaveBeenCalled();
  });

  it('refuses forks, closed proposals and people who cannot push', async () => {
    const d = deps();
    const c = suggestion('paper.qmd', 2, 'two', 'TWO');
    await expect(applyAllSuggestions(d, repo, { ...proposal, sameRepo: false }, access, [c])).rejects.toThrow(PermissionError);
    await expect(applyAllSuggestions(d, repo, { ...proposal, state: 'closed' }, access, [c])).rejects.toThrow(PermissionError);
    await expect(applyAllSuggestions(d, repo, proposal, { ...access, canPush: false }, [c])).rejects.toThrow(PermissionError);
    expect(d.repos.readFile).not.toHaveBeenCalled();
  });

  it('passes on a conflict from the fast-forward-only commit', async () => {
    const d = deps();
    d.reviews.commitToProposal.mockRejectedValue(new ConflictError('moved'));
    await expect(applyAllSuggestions(d, repo, proposal, access, [suggestion('paper.qmd', 2, 'two', 'TWO')])).rejects.toThrow(ConflictError);
  });
});

describe('applyAllSummary', () => {
  it('lists what went in and why the others were skipped', () => {
    const a = suggestion('paper.qmd', 2, 'two', 'TWO');
    const b = suggestion('notes.md', 7, 'x', 'y', 'eve');
    expect(applyAllSummary({ sha: 'c', applied: [a], skipped: [] }, en.applyAll)).toBe('Applied 1 suggestion in one change.');
    expect(applyAllSummary({ sha: 'c', applied: [a], skipped: [{ comment: b, reason: 'changed' }] }, en.applyAll)).toBe(
      'Applied 1 suggestion in one change. Skipped 1: notes.md:7 by eve: the lines changed',
    );
    expect(applyAllSummary({ applied: [], skipped: [{ comment: { ...b, line: null }, reason: 'outdated' }] }, en.applyAll)).toBe(
      'None of the suggestions could be applied. Skipped 1: notes.md:? by eve: refers to an earlier version',
    );
  });
});

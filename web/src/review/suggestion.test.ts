import { describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  PermissionError,
  SuggestionMismatchError,
  type Proposal,
  type RepoAccess,
  type ReviewComment,
} from '../domain';
import {
  applySuggestion,
  coAuthorTrailer,
  expectedLines,
  parseSuggestion,
  replaceLines,
  suggestionBlock,
} from './suggestion';

describe('parseSuggestion', () => {
  it('reads the first suggestion block', () => {
    expect(parseSuggestion('Better:\r\n```suggestion\r\nNew text\r\nsecond\r\n```\r\nthanks')).toBe('New text\nsecond');
    expect(parseSuggestion('````suggestion\nwith ``` inside\n````')).toBe('with ``` inside');
  });

  it('accepts a longer or indented closing fence, as GitHub does', () => {
    expect(parseSuggestion('```suggestion\nx\n`````')).toBe('x');
    expect(parseSuggestion('  ```suggestion\nx\n   ```')).toBe('x');
    expect(parseSuggestion('````suggestion\nx\n```\n````')).toBe('x\n```');
    expect(parseSuggestion('```suggestion\nx\n~~~')).toBeUndefined();
  });

  it('treats an empty block as deleting the lines', () => {
    expect(parseSuggestion('```suggestion\n```')).toBe('');
  });

  it('ignores comments without a suggestion', () => {
    expect(parseSuggestion('```js\nx\n```')).toBeUndefined();
    expect(parseSuggestion('just words')).toBeUndefined();
  });

  it('builds a block from the current lines', () => {
    expect(suggestionBlock(['a', 'b'])).toBe('```suggestion\na\nb\n```');
    expect(suggestionBlock(['has ``` fence'])).toBe('````suggestion\nhas ``` fence\n````');
  });
});

describe('expectedLines', () => {
  const hunk = '@@ -1,4 +1,4 @@\n # Title\n-Old\n+New one\n+New two\n Last';

  it('takes the new-side lines that end the diff hunk', () => {
    expect(expectedLines(hunk, 1)).toEqual(['Last']);
    expect(expectedLines(hunk, 3)).toEqual(['New one', 'New two', 'Last']);
  });

  it('ignores carriage returns in the hunk', () => {
    expect(expectedLines('@@ -1 +1 @@\r\n-a\r\n+b\r', 1)).toEqual(['b']);
  });

  it('fails when the hunk is shorter than the range', () => {
    expect(() => expectedLines(hunk, 9)).toThrow(SuggestionMismatchError);
  });
});

describe('replaceLines', () => {
  it('replaces exactly the suggested lines', () => {
    expect(replaceLines('a\nb\nc\nd\n', 2, 3, ['b', 'c'], 'B')).toBe('a\nB\nd\n');
    expect(replaceLines('a\nb\n', 2, 2, ['b'], '')).toBe('a\n');
    expect(replaceLines('a\r\nb\r\n', 1, 1, ['a'], 'x\ny')).toBe('x\r\ny\r\nb\r\n');
  });

  it('keeps CRLF endings consistent, with and without a final newline', () => {
    expect(replaceLines('a\r\nb\r\n', 2, 2, ['b'], 'x\ny')).toBe('a\r\nx\r\ny\r\n');
    expect(replaceLines('a\r\nb', 2, 2, ['b'], 'x\ny')).toBe('a\r\nx\r\ny');
    expect(replaceLines('a\r\nb', 1, 2, ['a', 'b'], 'z')).toBe('z');
    expect(replaceLines('a\nb', 2, 2, ['b'], 'x\ny')).toBe('a\nx\ny');
  });

  it('refuses when the lines changed since the comment', () => {
    expect(() => replaceLines('a\nX\nc\n', 2, 2, ['b'], 'B')).toThrow(SuggestionMismatchError);
    expect(() => replaceLines('a\n', 5, 5, ['b'], 'B')).toThrow(SuggestionMismatchError);
  });
});

describe('coAuthorTrailer', () => {
  it('uses the GitHub noreply address', () => {
    expect(coAuthorTrailer({ login: 'ana-b', id: 42 })).toBe('Co-authored-by: ana-b <42+ana-b@users.noreply.github.com>');
  });

  it('refuses logins that could break the trailer', () => {
    expect(coAuthorTrailer({ login: 'x>\nSigned-off-by: y', id: 1 })).toBeUndefined();
  });
});

describe('applySuggestion', () => {
  const comment: ReviewComment = {
    id: 9,
    author: { login: 'dir', id: 77 },
    body: 'Clearer:\n```suggestion\nA clearer sentence.\n```',
    path: 'paper.qmd',
    line: 3,
    startLine: 2,
    side: 'RIGHT',
    diffHunk: '@@ -1,3 +1,3 @@\n # Intro\n-Old\n+First half,\n second half.',
    subjectType: 'line',
    createdAt: '',
  };
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

  function deps(text = '# Intro\nFirst half,\nsecond half.\nEnd\n') {
    return {
      repos: { readFile: vi.fn(async () => text) },
      reviews: { commitToProposal: vi.fn(async () => 'c2') },
    };
  }

  it('commits the replaced lines on the proposal head with a co-author trailer', async () => {
    const d = deps();
    await expect(applySuggestion(d, repo, proposal, access, comment)).resolves.toBe('c2');

    expect(d.repos.readFile).toHaveBeenCalledWith(repo, 'paper.qmd', 'h1');
    expect(d.reviews.commitToProposal).toHaveBeenCalledWith(
      repo,
      proposal,
      [{ path: 'paper.qmd', content: '# Intro\nA clearer sentence.\nEnd\n' }],
      'Apply suggestion from @dir\n\nCo-authored-by: dir <77+dir@users.noreply.github.com>',
      'h1',
    );
  });

  it('refuses when the lines no longer match', async () => {
    const d = deps('# Intro\nRewritten meanwhile.\nsecond half.\n');
    await expect(applySuggestion(d, repo, proposal, access, comment)).rejects.toThrow(SuggestionMismatchError);
    expect(d.reviews.commitToProposal).not.toHaveBeenCalled();
  });

  it('refuses outdated comments', async () => {
    const d = deps();
    await expect(applySuggestion(d, repo, proposal, access, { ...comment, line: null })).rejects.toThrow(
      SuggestionMismatchError,
    );
  });

  it('refuses forks and users who cannot push', async () => {
    const d = deps();
    await expect(applySuggestion(d, repo, { ...proposal, sameRepo: false }, access, comment)).rejects.toThrow(
      PermissionError,
    );
    await expect(applySuggestion(d, repo, proposal, { ...access, canPush: false }, comment)).rejects.toThrow(
      PermissionError,
    );
    expect(d.repos.readFile).not.toHaveBeenCalled();
  });

  it('passes on a conflict from the fast-forward-only commit', async () => {
    const d = deps();
    d.reviews.commitToProposal.mockRejectedValue(new ConflictError('moved'));
    await expect(applySuggestion(d, repo, proposal, access, comment)).rejects.toThrow(ConflictError);
  });
});

import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { ChangedFile, Proposal, ReviewComment } from '../../domain';
import { groupThreads } from '../../review/threads';
import { ProposalList } from './ProposalList';
import { FileDiff } from './FileDiff';
import { MergeBox, People } from './SidePanel';

const noop = () => undefined;
const evil = '<img src=x onerror="alert(1)">';

const comment: ReviewComment = {
  id: 1,
  author: { login: 'dir', id: 9 },
  body: `Look ${evil}\n\`\`\`suggestion\nBetter ${evil}\n\`\`\``,
  path: 'paper.qmd',
  line: 2,
  startLine: null,
  side: 'RIGHT',
  diffHunk: '@@ -1,2 +1,2 @@\n a\n+b',
  subjectType: 'line',
  createdAt: '2026-10-28T10:00:00Z',
  htmlUrl: 'https://github.com/o/p/pull/1#discussion_r1',
};

const file: ChangedFile = {
  path: `fig${evil}.qmd`,
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch: `@@ -1,1 +1,2 @@\n a\n+${evil}`,
};

const diffProps = {
  file,
  threads: [],
  composer: undefined,
  replyDrafts: {},
  canApply: false,
  busy: false,
  onStartComment: noop,
  onComposer: noop,
  onSendComment: noop,
  onQueueComment: noop,
  onCancelComment: noop,
  onSuggest: noop,
  onReplyDraft: noop,
  onReply: noop,
  onApply: noop,
};

describe('review components render untrusted text as text', () => {
  it('escapes titles in the list and links only to GitHub', () => {
    const html = render(
      <ProposalList
        rows={[
          { summary: { number: 1, title: evil, updatedAt: '2026-10-28T10:00:00Z', draft: false, htmlUrl: 'https://github.com/o/p/pull/1' } },
          { summary: { number: 2, title: 'x', updatedAt: '', draft: true, htmlUrl: undefined } },
        ]}
        onOpen={noop}
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('href="https://github.com/o/p/pull/1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html.match(/href=/g)?.length).toBe(1);
  });

  it('escapes file names, patches, comments and suggestions', () => {
    const threads = groupThreads([{ ...comment, path: file.path }]);
    const html = render(<FileDiff {...diffProps} threads={threads} canApply />);
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/onerror="/);
    expect(html).toContain('Suggested change');
    expect(html).toContain('Apply suggestion');
    expect(html).toContain('View on GitHub');
  });

  it('shows LEFT threads on unchanged lines, and file comments apart from outdated ones', () => {
    const threads = groupThreads([
      { ...comment, id: 2, body: 'on old side', side: 'LEFT', line: 1, path: file.path },
      { ...comment, id: 3, body: 'about the whole file', line: null, subjectType: 'file', path: file.path },
      { ...comment, id: 4, body: 'gone', line: 77, path: file.path },
    ]);
    const html = render(<FileDiff {...diffProps} threads={threads} />);
    expect(html).toContain('on old side');
    expect(html).toContain('Comments on this file');
    expect(html.indexOf('about the whole file')).toBeLessThan(html.indexOf('Comments on an earlier version'));
    expect(html.indexOf('gone')).toBeGreaterThan(html.indexOf('Comments on an earlier version'));
  });

  it('explains a file without a readable diff', () => {
    const html = render(<FileDiff {...diffProps} file={{ ...file, path: 'fig.png', patch: undefined }} />);
    expect(html).toContain('No line-by-line view');
  });

  it('offers a comment button for each diff line', () => {
    const html = render(<FileDiff {...diffProps} />);
    expect(html).toContain('aria-label="Comment on line 2"');
  });
});

const proposal: Proposal = {
  number: 1,
  title: 't',
  updatedAt: '',
  draft: false,
  body: '',
  state: 'open',
  headSha: 'h',
  headBranch: 'b',
  sameRepo: true,
  baseBranch: 'main',
  mergeable: true,
  mergeableState: 'clean',
  requestedReviewers: [],
  assignees: [],
};

describe('MergeBox', () => {
  const props = { proposal, method: 'squash' as const, busy: false, onMethod: noop, onMerge: noop };

  it('shows the merge button only when GitHub allows it and the user can push', () => {
    const allowed = render(<MergeBox {...props} access={{ canPush: true, mergeMethods: ['squash', 'merge'] }} />);
    expect(allowed).toContain('>Merge</button>');
    expect(allowed).toContain('Combine into one change');

    const readOnly = render(<MergeBox {...props} access={{ canPush: false, mergeMethods: ['squash'] }} />);
    expect(readOnly).not.toContain('>Merge</button>');
    expect(readOnly).toContain('Only people who can change this repository can merge');

    const conflicted = render(
      <MergeBox {...props} proposal={{ ...proposal, mergeable: false, mergeableState: 'dirty' }} access={{ canPush: true, mergeMethods: ['squash'] }} />,
    );
    expect(conflicted).not.toContain('>Merge</button>');
    expect(conflicted).toContain('conflicts');
  });
});

describe('People', () => {
  it('shows each reviewer with their status', () => {
    const html = render(
      <People
        reviewers={[
          { person: { login: 'dir', id: 9 }, status: 'pending' },
          { person: { login: 'co', id: 8 }, status: 'changes_requested' },
        ]}
        assignees={[]}
        candidates={[{ login: 'x', id: 1 }]}
        canEdit
        busy={false}
        onRequest={noop}
        onRemoveReviewer={noop}
        onAssign={noop}
        onUnassign={noop}
      />,
    );
    expect(html).toContain('dir');
    expect(html).toContain('Waiting for review');
    expect(html).toContain('Changes requested');
  });

  it('hides reviewer and assignee controls without push access, with a hint', () => {
    const html = render(
      <People
        reviewers={[{ person: { login: 'dir', id: 9 }, status: 'pending' }]}
        assignees={[{ login: 'ana', id: 1 }]}
        candidates={[{ login: 'x', id: 1 }]}
        canEdit={false}
        editHint="Only people who can change this repository can ask for reviews or assign people."
        busy={false}
        onRequest={noop}
        onRemoveReviewer={noop}
        onAssign={noop}
        onUnassign={noop}
      />,
    );
    expect(html).not.toContain('Remove');
    expect(html).not.toContain('<select');
    expect(html).toContain('Only people who can change this repository');
  });
});

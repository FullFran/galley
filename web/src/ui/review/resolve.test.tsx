import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import type { ChangedFile, ReviewComment, ReviewThreadState } from '../../domain';
import { groupThreads } from '../../review/threads';
import { FileDiff, type FileDiffProps } from './FileDiff';

const noop = () => undefined;
const file: ChangedFile = { path: 'paper.qmd', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1,1 +1,2 @@\n a\n+b' };
const comment: ReviewComment = {
  id: 11,
  author: { login: 'dir', id: 9 },
  body: 'Hmm',
  path: 'paper.qmd',
  line: 2,
  startLine: null,
  side: 'RIGHT',
  diffHunk: '@@ -1,1 +1,2 @@\n a\n+b',
  subjectType: 'line',
  createdAt: '2026-10-28T10:00:00Z',
};
const state = (over: Partial<ReviewThreadState>): ReviewThreadState => ({
  id: 'PRRT_1',
  rootCommentId: 11,
  resolved: false,
  canResolve: false,
  canUnresolve: false,
  ...over,
});

const diff = (threadStates?: Record<number, ReviewThreadState>) => {
  const props: FileDiffProps = {
    file,
    threads: groupThreads([comment]),
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
    threadStates,
    onResolveThread: noop,
  };
  return render(<FileDiff {...props} />);
};

describe('resolving review threads', () => {
  it('offers Resolve only when GitHub says the viewer can', () => {
    expect(diff()).not.toContain('Resolve conversation');
    expect(diff({ 11: state({ canResolve: false }) })).not.toContain('Resolve conversation');
    expect(diff({ 11: state({ canResolve: true }) })).toContain('Resolve conversation');
  });

  it('folds a resolved thread and offers Reopen when allowed', () => {
    const html = diff({ 11: state({ resolved: true, canUnresolve: true }) });
    expect(html).toContain('Resolved');
    expect(html).toContain('Reopen conversation');
    expect(html).not.toContain('Hmm');
    expect(diff({ 11: state({ resolved: true }) })).not.toContain('Reopen conversation');
  });
});

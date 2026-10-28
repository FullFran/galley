import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact-render-to-string';
import type { CommentThread, ThreadComment } from '../../domain/comments';
import { applyThreadSuggestion, threadPermissions, visibleThreads } from '../../comments/actions';
import { ThreadsPanel, type ThreadsPanelProps } from './ThreadsPanel';

const SHA = 'b'.repeat(40);
const evil = '<img src=x onerror="alert(1)">';
const noop = () => undefined;

const comment = (over: Partial<ThreadComment> = {}): ThreadComment => ({
  id: 'c00000000000001',
  threadId: 't00000000000001',
  author: { kind: 'human', login: 'ana' },
  mine: false,
  body: `Please check ${evil}`,
  createdAt: '2026-10-28T10:00:00Z',
  ...over,
});

const thread = (over: Partial<CommentThread> = {}): CommentThread => ({
  id: 't00000000000001',
  repoId: 1,
  repoFullName: 'o/p',
  status: 'open',
  origin: 'source',
  anchor: {
    path: 'index.qmd',
    commitSha: SHA,
    startLine: 2,
    endLine: 2,
    startColumn: 5,
    endColumn: 8,
    quote: { exact: 'rate', prefix: 'The ', suffix: ' of' },
  },
  position: { commitSha: SHA, startLine: 2, endLine: 2, startColumn: 5, endColumn: 8, state: 'exact' },
  createdBy: 'ana',
  createdAt: '2026-10-28T10:00:00Z',
  updatedAt: '2026-10-28T10:00:00Z',
  comments: [comment()],
  ...over,
});

const panel = (props: Partial<ThreadsPanelProps>) =>
  render(
    <ThreadsPanel
      threads={[thread()]}
      state="ready"
      truncated={false}
      scope="file"
      showResolved={false}
      canPush={false}
      openPath="index.qmd"
      unread={{}}
      busy={false}
      onScope={noop}
      onShowResolved={noop}
      onOpen={noop}
      onReply={noop}
      onEdit={noop}
      onDelete={noop}
      onResolve={noop}
      onReopen={noop}
      onApply={noop}
      onDraft={noop}
      onPost={noop}
      onCancelDraft={noop}
      onClose={noop}
      onRetry={noop}
      {...props}
    />,
  );

describe('threads panel', () => {
  it('renders comment text, quotes and logins as text only', () => {
    const html = panel({
      threads: [thread({ anchor: { ...thread().anchor, quote: { exact: evil, prefix: '', suffix: '' } }, comments: [comment({ author: { kind: 'human', login: evil } })] })],
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('shows Resolve only to people with push', () => {
    expect(panel({ canPush: false })).not.toContain('>Resolve<');
    expect(panel({ canPush: true })).toContain('>Resolve<');
    const resolved = [thread({ status: 'resolved', resolvedBy: 'bo' })];
    expect(panel({ canPush: true, showResolved: true, threads: resolved })).toContain('>Reopen<');
    expect(panel({ canPush: false, showResolved: true, threads: resolved })).not.toContain('>Reopen<');
  });

  it('offers Edit and Delete on the user’s own comments only', () => {
    expect(panel({})).not.toContain('>Edit<');
    const mine = panel({ threads: [thread({ comments: [comment({ mine: true })] })] });
    expect(mine).toContain('>Edit<');
    expect(mine).toContain('>Delete<');
  });

  it('shows unread counts and AI authors distinctly', () => {
    const html = panel({
      unread: { t00000000000001: 2 },
      threads: [thread({ comments: [comment({ author: { kind: 'ai', login: 'ana', aiClient: 'claude', aiModel: 'm1' } })] })],
    });
    expect(html).toContain('2 new');
    expect(html).toContain('AI (claude, m1) via ana');
  });

  it('shows a suggestion as a diff with Apply', () => {
    const html = panel({ threads: [thread({ comments: [comment({ suggestion: { text: 'speed', baseSha: SHA } })] })] });
    expect(html).toContain('suggestion-diff');
    expect(html).toMatch(/<del[^>]*>rate<\/del>/);
    expect(html).toMatch(/<ins[^>]*>speed<\/ins>/);
    expect(html).toContain('Apply to my copy');
  });
});

describe('thread permissions and lists', () => {
  it('gates resolve and reopen on push and the status', () => {
    expect(threadPermissions(thread(), false)).toMatchObject({ resolve: false, reopen: false });
    expect(threadPermissions(thread(), true)).toMatchObject({ resolve: true, reopen: false });
    expect(threadPermissions(thread({ status: 'resolved' }), true)).toMatchObject({ resolve: false, reopen: true });
  });

  it('filters by file and status, ordered by line', () => {
    const a = thread({ id: 'a00000000000001', position: { ...thread().position, startLine: 9 } });
    const b = thread({ id: 'b00000000000001', anchor: { ...thread().anchor, path: 'other.qmd' } });
    const c = thread({ id: 'c00000000000001', status: 'resolved' });
    const d = thread({ id: 'd00000000000001' });
    expect(visibleThreads([a, b, c, d], { scope: 'file', path: 'index.qmd', showResolved: false }).map((t) => t.id)).toEqual([
      'd00000000000001',
      'a00000000000001',
    ]);
    expect(visibleThreads([a, b, c, d], { scope: 'paper', showResolved: true })).toHaveLength(4);
  });
});

describe('applying a suggestion', () => {
  const text = 'Title\nThe rate of decay';
  const withSuggestion = comment({ suggestion: { text: 'speed', baseSha: SHA } });

  it('edits the buffer only and does not resolve without push', async () => {
    const edit = vi.fn();
    const resolve = vi.fn(() => Promise.resolve());
    expect(await applyThreadSuggestion(thread(), withSuggestion, { text, edit, resolve, canPush: false })).toBe('applied');
    expect(edit).toHaveBeenCalledWith(10, 14, 'speed');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolves the thread when the user has push', async () => {
    const edit = vi.fn();
    const resolve = vi.fn(() => Promise.resolve());
    expect(await applyThreadSuggestion(thread(), withSuggestion, { text, edit, resolve, canPush: true })).toBe('applied-resolved');
    expect(resolve).toHaveBeenCalledWith('t00000000000001');
  });

  it('changes nothing when the quoted text is gone', async () => {
    const edit = vi.fn();
    const resolve = vi.fn(() => Promise.resolve());
    expect(await applyThreadSuggestion(thread(), withSuggestion, { text: 'nothing here', edit, resolve, canPush: true })).toBe('failed');
    expect(edit).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});

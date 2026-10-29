import { describe, expect, it, vi } from 'vitest';
import {
  ConflictError,
  NotMergeableError,
  PermissionError,
  RejectedError,
  type Repository,
} from '../domain';
import { fakeFetch, json, on, type RecordedRequest, type Route } from '../test/fakeFetch';
import { createGitHubReviewGateway } from './review';

const GH = 'https://api.github.com';
const R = `${GH}/repos/octo/paper`;
const repo: Repository = { id: 7, owner: 'octo', name: 'paper', fullName: 'octo/paper', defaultBranch: 'main', private: true };

function gateway(routes: Route[]) {
  const source = { getAccessToken: vi.fn(async () => 'tok'), invalidate: vi.fn() };
  const fake = fakeFetch(routes);
  return { gw: createGitHubReviewGateway({ tokens: source, fetch: fake.fetch }), ...fake, source };
}

const only = (requests: RecordedRequest[], method: string) => requests.filter((r) => r.method === method);

const ghPull = (extra: Record<string, unknown> = {}) => ({
  number: 4,
  title: 'Rewrite <b>intro</b>',
  body: null,
  user: { login: 'ana', id: 1 },
  updated_at: '2026-10-28T10:00:00Z',
  draft: false,
  html_url: 'https://github.com/octo/paper/pull/4',
  state: 'open',
  merged_at: null,
  mergeable: true,
  mergeable_state: 'clean',
  head: { sha: 'h1', ref: 'galley/ana', repo: { full_name: 'octo/paper' } },
  base: { ref: 'main', repo: { full_name: 'octo/paper' } },
  requested_reviewers: [{ login: 'dir', id: 9 }],
  assignees: [],
  ...extra,
});

describe('GitHub review gateway', () => {
  it('lists every open pull request, most recently updated first', async () => {
    const page2 = `${R}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=2`;
    const { gw, source } = gateway([
      on('GET', `${R}/pulls?state=open&sort=updated&direction=desc&per_page=100`, () =>
        json([ghPull()], 200, { Link: `<${page2}>; rel="next"` }),
      ),
      on('GET', page2, () => json([ghPull({ number: 5, html_url: 'javascript:alert(1)', user: null })])),
    ]);

    const list = await gw.listProposals(repo);

    expect(list).toEqual([
      {
        number: 4,
        title: 'Rewrite <b>intro</b>',
        author: { login: 'ana', id: 1 },
        updatedAt: '2026-10-28T10:00:00Z',
        draft: false,
        htmlUrl: 'https://github.com/octo/paper/pull/4',
      },
      { number: 5, title: 'Rewrite <b>intro</b>', author: undefined, updatedAt: '2026-10-28T10:00:00Z', draft: false, htmlUrl: undefined },
    ]);
    expect(source.getAccessToken).toHaveBeenCalledWith();
  });

  it('reads a proposal with its head, mergeability and people', async () => {
    const { gw } = gateway([
      on('GET', `${R}/pulls/4`, () =>
        json(ghPull({ head: { sha: 'h1', ref: 'feature', repo: { full_name: 'fork/paper' } }, merged_at: '2026-10-28', state: 'closed' })),
      ),
    ]);

    await expect(gw.getProposal(repo, 4)).resolves.toMatchObject({
      number: 4,
      body: '',
      state: 'merged',
      headSha: 'h1',
      headBranch: 'feature',
      sameRepo: false,
      baseBranch: 'main',
      mergeable: true,
      mergeableState: 'clean',
      requestedReviewers: [{ login: 'dir', id: 9 }],
      assignees: [],
    });
  });

  it('lists changed files with their patch, which may be missing', async () => {
    const { gw } = gateway([
      on('GET', `${R}/pulls/4/files?per_page=100`, () =>
        json([
          { filename: 'paper.qmd', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
          { filename: 'fig.png', previous_filename: 'old.png', status: 'renamed', additions: 0, deletions: 0 },
        ]),
      ),
    ]);

    await expect(gw.listChangedFiles(repo, 4)).resolves.toEqual([
      { path: 'paper.qmd', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b', previousPath: undefined },
      { path: 'fig.png', previousPath: 'old.png', status: 'renamed', additions: 0, deletions: 0, patch: undefined },
    ]);
  });

  it('lists review comments and reviews', async () => {
    const { gw } = gateway([
      on('GET', `${R}/pulls/4/comments?per_page=100`, () =>
        json([
          {
            id: 11,
            in_reply_to_id: 10,
            user: { login: 'dir', id: 9 },
            body: 'ok',
            path: 'paper.qmd',
            line: null,
            start_line: null,
            side: 'RIGHT',
            diff_hunk: '@@',
            created_at: 't',
            html_url: 'https://github.com/octo/paper/pull/4#discussion_r11',
          },
        ]),
      ),
      on('GET', `${R}/pulls/4/reviews?per_page=100`, () =>
        json([
          { id: 1, user: { login: 'dir', id: 9 }, state: 'CHANGES_REQUESTED', body: 'see', submitted_at: 't' },
          { id: 2, user: { login: 'me', id: 3 }, state: 'PENDING', body: '' },
        ]),
      ),
    ]);

    await expect(gw.listReviewComments(repo, 4)).resolves.toEqual([
      {
        id: 11,
        inReplyToId: 10,
        author: { login: 'dir', id: 9 },
        body: 'ok',
        path: 'paper.qmd',
        line: null,
        startLine: null,
        side: 'RIGHT',
        diffHunk: '@@',
        subjectType: 'line',
        createdAt: 't',
        htmlUrl: 'https://github.com/octo/paper/pull/4#discussion_r11',
      },
    ]);
    await expect(gw.listReviews(repo, 4)).resolves.toEqual([
      { id: 1, author: { login: 'dir', id: 9 }, state: 'changes_requested', body: 'see', submittedAt: 't' },
      { id: 2, author: { login: 'me', id: 3 }, state: 'pending', body: '', submittedAt: undefined },
    ]);
  });

  it('creates single-line and multi-line comments on the head commit', async () => {
    const created = { id: 20, user: { login: 'me', id: 3 }, body: 'x', path: 'p.qmd', line: 5, start_line: null, side: 'RIGHT', diff_hunk: '', created_at: 't', html_url: '' };
    const { gw, requests } = gateway([on('POST', `${R}/pulls/4/comments`, () => json(created, 201))]);

    await gw.addComment(repo, 4, 'h1', { path: 'p.qmd', line: 5, side: 'RIGHT', body: 'x' });
    await gw.addComment(repo, 4, 'h1', { path: 'p.qmd', line: 7, side: 'LEFT', startLine: 5, body: 'range' });

    expect(only(requests, 'POST').map((r) => r.body)).toEqual([
      { body: 'x', commit_id: 'h1', path: 'p.qmd', line: 5, side: 'RIGHT' },
      { body: 'range', commit_id: 'h1', path: 'p.qmd', line: 7, side: 'LEFT', start_line: 5, start_side: 'LEFT' },
    ]);
  });

  it('replies to the first comment of a thread', async () => {
    const { gw, requests } = gateway([
      on('POST', `${R}/pulls/4/comments/10/replies`, () =>
        json({ id: 21, in_reply_to_id: 10, body: 'thanks', path: 'p', line: 1, side: 'RIGHT', diff_hunk: '', created_at: 't' }, 201),
      ),
    ]);

    await expect(gw.reply(repo, 4, 10, 'thanks')).resolves.toMatchObject({ id: 21, inReplyToId: 10, startLine: null });
    expect(requests[0]?.body).toEqual({ body: 'thanks' });
  });

  it('submits a review with its pending comments in one request', async () => {
    const { gw, requests } = gateway([on('POST', `${R}/pulls/4/reviews`, () => json({ id: 3 }, 200))]);

    await gw.submitReview(repo, 4, {
      event: 'REQUEST_CHANGES',
      body: 'Please fix',
      commitId: 'h1',
      comments: [
        { path: 'p.qmd', line: 3, side: 'RIGHT', body: 'a' },
        { path: 'p.qmd', line: 9, side: 'RIGHT', startLine: 8, body: 'b' },
      ],
    });
    await gw.submitReview(repo, 4, { event: 'APPROVE', body: '', commitId: 'h1', comments: [] });

    expect(only(requests, 'POST').map((r) => r.body)).toEqual([
      {
        commit_id: 'h1',
        event: 'REQUEST_CHANGES',
        body: 'Please fix',
        comments: [
          { path: 'p.qmd', body: 'a', line: 3, side: 'RIGHT' },
          { path: 'p.qmd', body: 'b', line: 9, side: 'RIGHT', start_line: 8, start_side: 'RIGHT' },
        ],
      },
      { commit_id: 'h1', event: 'APPROVE' },
    ]);
  });

  it('reads push access and the allowed merge methods', async () => {
    const { gw } = gateway([
      on('GET', R, () =>
        json({ permissions: { push: true }, allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true }),
      ),
    ]);
    await expect(gw.access(repo)).resolves.toEqual({ canPush: true, admin: false, mergeMethods: ['squash', 'rebase'] });
  });

  it('reads admin access, which galley uses for project settings', async () => {
    const { gw } = gateway([on('GET', R, () => json({ permissions: { admin: true, push: true } }))]);
    await expect(gw.access(repo)).resolves.toEqual({ canPush: true, admin: true, mergeMethods: [] });
  });

  it('offers no merge method when GitHub hides the merge settings', async () => {
    const { gw } = gateway([on('GET', R, () => json({ permissions: { push: false, pull: true } }))]);
    await expect(gw.access(repo)).resolves.toEqual({ canPush: false, admin: false, mergeMethods: [] });
  });

  it('lists people who can be assigned as candidates', async () => {
    const { gw } = gateway([on('GET', `${R}/assignees?per_page=100`, () => json([{ login: 'dir', id: 9, extra: 1 }]))]);
    await expect(gw.listCandidates(repo)).resolves.toEqual([{ login: 'dir', id: 9 }]);
  });

  it('requests and removes reviewers', async () => {
    const { gw, requests } = gateway([
      on('POST', `${R}/pulls/4/requested_reviewers`, () => json({}, 201)),
      on('DELETE', `${R}/pulls/4/requested_reviewers`, () => json({}, 200)),
    ]);

    await gw.requestReviewers(repo, 4, ['dir']);
    await gw.removeReviewers(repo, 4, ['dir']);

    expect(requests.map((r) => [r.method, r.body])).toEqual([
      ['POST', { reviewers: ['dir'] }],
      ['DELETE', { reviewers: ['dir'] }],
    ]);
  });

  it('reports a reviewer without write access as rejected (422)', async () => {
    const { gw } = gateway([
      on('POST', `${R}/pulls/4/requested_reviewers`, () =>
        json({ message: 'Reviews may only be requested from collaborators.' }, 422),
      ),
    ]);
    await expect(gw.requestReviewers(repo, 4, ['stranger'])).rejects.toMatchObject({ action: 'reviewers' });
  });

  it('tags every other 422 with the action that failed', () => {
    const refuse = () => json({ message: 'Validation Failed' }, 422);
    const { gw } = gateway([
      on('POST', `${R}/pulls/4/comments`, refuse),
      on('POST', `${R}/pulls/4/reviews`, refuse),
      on('POST', `${R}/issues/4/assignees`, refuse),
    ]);
    return Promise.all([
      expect(gw.addComment(repo, 4, 'h1', { path: 'p', line: 99, side: 'RIGHT', body: 'x' })).rejects.toMatchObject({
        action: 'comment',
      }),
      expect(gw.submitReview(repo, 4, { event: 'COMMENT', body: '', commitId: 'h1', comments: [] })).rejects.toMatchObject({
        action: 'review',
      }),
      expect(gw.addAssignees(repo, 4, ['x'])).rejects.toBeInstanceOf(RejectedError),
    ]);
  });

  it('adds and removes assignees through the issues API', async () => {
    const { gw, requests } = gateway([
      on('POST', `${R}/issues/4/assignees`, () => json({}, 201)),
      on('DELETE', `${R}/issues/4/assignees`, () => json({}, 200)),
    ]);

    await gw.addAssignees(repo, 4, ['ana']);
    await gw.removeAssignees(repo, 4, ['ana']);

    expect(requests.map((r) => [r.method, r.body])).toEqual([
      ['POST', { assignees: ['ana'] }],
      ['DELETE', { assignees: ['ana'] }],
    ]);
  });

  it('merges with the expected head and the chosen method', async () => {
    const { gw, requests } = gateway([on('PUT', `${R}/pulls/4/merge`, () => json({ merged: true, sha: 'm2' }))]);

    await gw.merge(repo, 4, 'h1', 'squash');

    expect(requests[0]?.body).toEqual({ sha: 'h1', merge_method: 'squash' });
  });

  it('reports a moved head (409) as a conflict and a refused merge (405) as not mergeable', async () => {
    const { gw } = gateway([
      on('PUT', `${R}/pulls/4/merge`, () => json({ message: 'Head branch was modified.' }, 409)),
      on('PUT', `${R}/pulls/5/merge`, () => json({ message: 'Pull Request is not mergeable' }, 405)),
    ]);

    await expect(gw.merge(repo, 4, 'h1', 'merge')).rejects.toThrow(ConflictError);
    await expect(gw.merge(repo, 5, 'h1', 'merge')).rejects.toThrow(NotMergeableError);
  });

  it('commits to the proposal head fast-forward only', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'h1' } })),
      on('GET', `${R}/git/commits/h1`, () => json({ tree: { sha: 't1' } })),
      on('GET', `${R}/git/trees/t1?recursive=1`, () => json({ truncated: false, tree: [] })),
      on('POST', `${R}/git/trees`, () => json({ sha: 't2' }, 201)),
      on('POST', `${R}/git/commits`, () => json({ sha: 'c2' }, 201)),
      on('PATCH', `${R}/git/refs/heads/galley/ana`, () => json({}, 200)),
    ]);

    const sha = await gw.commitToProposal(
      repo,
      { headBranch: 'galley/ana', sameRepo: true },
      [{ path: 'p.qmd', content: 'x' }],
      'Apply suggestion',
      'h1',
    );

    expect(sha).toBe('c2');
    expect(only(requests, 'POST')[1]?.body).toEqual({ message: 'Apply suggestion', tree: 't2', parents: ['h1'] });
    expect(only(requests, 'PATCH')[0]?.body).toEqual({ sha: 'c2', force: false });
  });

  it('refuses to commit when the head moved, and to forks', async () => {
    const { gw, requests } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'other' } })),
    ]);
    const changes = [{ path: 'p', content: 'x' }];

    await expect(gw.commitToProposal(repo, { headBranch: 'galley/ana', sameRepo: true }, changes, 'm', 'h1')).rejects.toThrow(
      ConflictError,
    );
    await expect(gw.commitToProposal(repo, { headBranch: 'x', sameRepo: false }, changes, 'm', 'h1')).rejects.toThrow(
      PermissionError,
    );
    expect(requests.some((r) => r.method !== 'GET')).toBe(false);
  });

  it('reads the signed-in user once', async () => {
    const { gw, requests } = gateway([on('GET', `${GH}/user`, () => json({ login: 'me', id: 3, name: 'x' }))]);
    await gw.currentUser();
    await expect(gw.currentUser()).resolves.toEqual({ login: 'me', id: 3 });
    expect(requests).toHaveLength(1);
  });

  it('reports a head branch that refuses the update but did not move as protected, not as moved', async () => {
    const { gw } = gateway([
      on('GET', `${R}/git/ref/heads/galley/ana`, () => json({ object: { sha: 'h1' } })),
      on('GET', `${R}/git/commits/h1`, () => json({ tree: { sha: 't1' } })),
      on('GET', `${R}/git/trees/t1?recursive=1`, () => json({ truncated: false, tree: [] })),
      on('POST', `${R}/git/trees`, () => json({ sha: 't2' }, 201)),
      on('POST', `${R}/git/commits`, () => json({ sha: 'c2' }, 201)),
      on('PATCH', `${R}/git/refs/heads/galley/ana`, () => json({ message: 'Protected branch' }, 422)),
    ]);
    await expect(
      gw.commitToProposal(repo, { headBranch: 'galley/ana', sameRepo: true }, [{ path: 'p', content: 'x' }], 'm', 'h1'),
    ).rejects.toMatchObject({ action: 'branch' });
  });

  it('maps file-level comments', async () => {
    const { gw } = gateway([
      on('GET', `${R}/pulls/4/comments?per_page=100`, () =>
        json([{ id: 1, body: 'b', path: 'p', line: null, subject_type: 'file', diff_hunk: '', created_at: 't' }]),
      ),
    ]);
    await expect(gw.listReviewComments(repo, 4)).resolves.toMatchObject([{ subjectType: 'file', line: null }]);
  });

  it('lists the files at a commit for the preview', async () => {
    const { gw } = gateway([
      on('GET', `${R}/git/trees/h1?recursive=1`, () =>
        json({ truncated: false, tree: [{ path: 'a.qmd', type: 'blob' }, { path: 'd', type: 'tree' }] }),
      ),
    ]);
    await expect(gw.listFiles(repo, 'h1')).resolves.toEqual({ files: ['a.qmd'], truncated: false });
  });
});

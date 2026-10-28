import {
  ConflictError,
  NotMergeableError,
  PermissionError,
  RejectedError,
  type ChangedFile,
  type DiffSide,
  type MergeMethod,
  type NewComment,
  type Person,
  type Proposal,
  type ProposalSummary,
  type RejectedAction,
  type Repository,
  type Review,
  type ReviewComment,
  type ReviewGateway,
  type ReviewThreadState,
} from '../domain';
import { githubUrl } from '../review/status';
import { GitHubClient, type TokenSource } from './client';
import { branchHead, createCommit, fastForward, listTree, repoBase } from './git';

// Endpoints and the GitHub App permission each one needs (user access token):
//   pulls list/get/files/comments/reviews (GET)       Pull requests: read
//   pulls comments, replies, reviews, reviewers (POST/DELETE)  Pull requests: write
//   issues/{n}/assignees (POST/DELETE)                 Issues or Pull requests: write
//   assignees (GET)                                    Issues or Pull requests: read
//   repos/{o}/{r} (GET; merge settings need Contents)  Metadata: read
//   pulls/{n}/merge (PUT), git data (POST/PATCH)       Contents: write
//   GraphQL reviewThreads (query)                      Pull requests: read
//   GraphQL resolve/unresolveReviewThread (mutation)   Pull requests: write

export interface GitHubReviewGatewayOptions {
  tokens: TokenSource;
  fetch?: typeof globalThis.fetch;
}

interface GhUser {
  login: string;
  id: number;
}

interface GhPull {
  number: number;
  title: string;
  body: string | null;
  user: GhUser | null;
  updated_at: string;
  draft?: boolean;
  html_url: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
  requested_reviewers?: GhUser[];
  assignees?: GhUser[] | null;
}

interface GhFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GhComment {
  id: number;
  in_reply_to_id?: number;
  user?: GhUser | null;
  body: string;
  path: string;
  line?: number | null;
  start_line?: number | null;
  side?: DiffSide;
  diff_hunk: string;
  subject_type?: 'line' | 'file';
  created_at: string;
  html_url?: string;
}

interface GhReview {
  id: number;
  user: GhUser | null;
  state: string;
  body: string | null;
  submitted_at?: string;
}

interface GhRepoAccess {
  permissions?: { push?: boolean; admin?: boolean };
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
}

const REVIEW_STATES: Record<string, Review['state']> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
};

/** ReviewGateway backed by the GitHub REST API, with the user's own access token. */
export function createGitHubReviewGateway(options: GitHubReviewGatewayOptions): ReviewGateway {
  const gh = new GitHubClient(options.tokens, options.fetch ?? globalThis.fetch.bind(globalThis));
  const pull = (repo: Repository, n: number) => `${repoBase(repo)}/pulls/${n}`;
  const list = <T,>(repo: Repository, path: string) => gh.paginate(path, (page: T[]) => page, repo.id);
  const send = <T,>(repo: Repository, path: string, method: string, body: unknown, action: RejectedAction) =>
    tagRejected(gh.request<T>(path, { repositoryId: repo.id, method, body }), action);

  let me: Promise<Person> | undefined;

  return {
    currentUser() {
      me ??= gh.request<GhUser>('/user').then((r) => ({ login: r.data.login, id: r.data.id }));
      me.catch(() => (me = undefined));
      return me;
    },

    async listProposals(repo) {
      const pulls = await list<GhPull>(repo, `${repoBase(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=100`);
      return pulls.map(toSummary);
    },

    async getProposal(repo, n) {
      const { data } = await gh.request<GhPull>(pull(repo, n), { repositoryId: repo.id });
      return toProposal(data);
    },

    async listChangedFiles(repo, n) {
      const files = await list<GhFile>(repo, `${pull(repo, n)}/files?per_page=100`);
      return files.map(
        (f): ChangedFile => ({
          path: f.filename,
          previousPath: f.previous_filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        }),
      );
    },

    async listReviewComments(repo, n) {
      return (await list<GhComment>(repo, `${pull(repo, n)}/comments?per_page=100`)).map(toComment);
    },

    async listReviews(repo, n) {
      const reviews = await list<GhReview>(repo, `${pull(repo, n)}/reviews?per_page=100`);
      return reviews.flatMap((r): Review[] => {
        const state = REVIEW_STATES[r.state];
        if (!state) return [];
        return [{ id: r.id, author: toPerson(r.user), state, body: r.body ?? '', submittedAt: r.submitted_at }];
      });
    },

    async listReviewThreads(repo, n) {
      const out: ReviewThreadState[] = [];
      let after: string | null = null;
      for (let page = 0; page < MAX_THREAD_PAGES; page++) {
        const data: GqlThreadsPage = await gh.graphql<GqlThreadsPage>(
          THREADS_QUERY,
          { owner: repo.owner, name: repo.name, number: n, after },
          repo.id,
        );
        const conn = data.repository?.pullRequest?.reviewThreads;
        if (!conn) break;
        for (const node of conn.nodes ?? []) {
          const state = toThreadState(node);
          if (state) out.push(state);
        }
        if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
        after = conn.pageInfo.endCursor;
      }
      return out;
    },

    async setThreadResolved(repo, threadId, resolved) {
      const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
      const data = await gh.graphql<Record<string, { thread?: GqlThread } | null>>(
        resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION,
        { id: threadId },
        repo.id,
      );
      const state = toThreadState(data[field]?.thread);
      if (!state) throw new RejectedError('GitHub did not return the review thread', 'comment');
      return state;
    },

    listFiles: (repo, ref) => listTree(gh, repo, ref),

    async addComment(repo, n, commitId, comment) {
      const body = { body: comment.body, commit_id: commitId, path: comment.path, ...toPosition(comment) };
      const { data } = await send<GhComment>(repo, `${pull(repo, n)}/comments`, 'POST', body, 'comment');
      return toComment(data);
    },

    async reply(repo, n, rootCommentId, body) {
      const { data } = await send<GhComment>(repo, `${pull(repo, n)}/comments/${rootCommentId}/replies`, 'POST', { body }, 'comment');
      return toComment(data);
    },

    async submitReview(repo, n, review) {
      const body: Record<string, unknown> = { commit_id: review.commitId, event: review.event };
      if (review.body) body.body = review.body;
      if (review.comments.length > 0) {
        body.comments = review.comments.map((c) => ({ path: c.path, body: c.body, ...toPosition(c) }));
      }
      await send(repo, `${pull(repo, n)}/reviews`, 'POST', body, 'review');
    },

    async access(repo) {
      const { data } = await gh.request<GhRepoAccess>(repoBase(repo), { repositoryId: repo.id });
      // GitHub only shows merge settings to people with write access; absent means not allowed here.
      const mergeMethods: MergeMethod[] = [];
      if (data.allow_merge_commit) mergeMethods.push('merge');
      if (data.allow_squash_merge) mergeMethods.push('squash');
      if (data.allow_rebase_merge) mergeMethods.push('rebase');
      return { canPush: data.permissions?.push === true, admin: data.permissions?.admin === true, mergeMethods };
    },

    async listCandidates(repo) {
      const users = await list<GhUser>(repo, `${repoBase(repo)}/assignees?per_page=100`);
      return users.map((u) => ({ login: u.login, id: u.id }));
    },

    async requestReviewers(repo, n, logins) {
      await send(repo, `${pull(repo, n)}/requested_reviewers`, 'POST', { reviewers: logins }, 'reviewers');
    },

    async removeReviewers(repo, n, logins) {
      await send(repo, `${pull(repo, n)}/requested_reviewers`, 'DELETE', { reviewers: logins }, 'reviewers');
    },

    async addAssignees(repo, n, logins) {
      await send(repo, `${repoBase(repo)}/issues/${n}/assignees`, 'POST', { assignees: logins }, 'assignees');
    },

    async removeAssignees(repo, n, logins) {
      await send(repo, `${repoBase(repo)}/issues/${n}/assignees`, 'DELETE', { assignees: logins }, 'assignees');
    },

    async merge(repo, n, sha, method) {
      // `sha` makes GitHub refuse (409) if commits arrived after the user looked.
      const res = await gh.request<{ message?: string }>(`${pull(repo, n)}/merge`, {
        repositoryId: repo.id,
        method: 'PUT',
        allow: [405, 409],
        body: { sha, merge_method: method },
      });
      const detail = `GitHub ${res.status}: ${res.data?.message ?? ''}`;
      if (res.status === 409) throw new ConflictError(detail);
      if (res.status === 405) throw new NotMergeableError(detail);
    },

    async commitToProposal(repo, proposal, changes, message, expectedHeadSha) {
      if (!proposal.sameRepo) throw new PermissionError('the proposal comes from another repository');
      const moved = () => new ConflictError(`${proposal.headBranch} moved since it was opened`);
      if ((await branchHead(gh, repo, proposal.headBranch)) !== expectedHeadSha) throw moved();
      const sha = await createCommit(gh, repo, changes, message, expectedHeadSha);
      if (await fastForward(gh, repo, proposal.headBranch, sha)) return sha;
      // 422 either because the branch moved, or because it may not be updated (protected).
      if ((await branchHead(gh, repo, proposal.headBranch)) !== expectedHeadSha) throw moved();
      throw new RejectedError(`${proposal.headBranch} cannot be updated`, 'branch');
    },
  };
}

// Review thread resolution exists only in GraphQL. Fields per
// https://docs.github.com/en/graphql/reference/pulls (PullRequestReviewThread:
// id, isResolved, viewerCanResolve, viewerCanUnresolve, comments; mutations
// resolveReviewThread / unresolveReviewThread with input { threadId }). The
// docs list no permission for the mutations; galley shows the buttons only
// when GitHub says the viewer can (viewerCanResolve / viewerCanUnresolve),
// which in practice means write access or being the pull request's author.
const THREAD_FIELDS = 'id isResolved viewerCanResolve viewerCanUnresolve comments(first: 1) { nodes { databaseId } }';
const THREADS_QUERY = `query ($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${THREAD_FIELDS} }
      }
    }
  }
}`;
const RESOLVE_MUTATION = `mutation ($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { ${THREAD_FIELDS} } } }`;
const UNRESOLVE_MUTATION = `mutation ($id: ID!) { unresolveReviewThread(input: { threadId: $id }) { thread { ${THREAD_FIELDS} } } }`;
/** At most 1,000 threads per proposal. */
const MAX_THREAD_PAGES = 10;

interface GqlThread {
  id?: unknown;
  isResolved?: unknown;
  viewerCanResolve?: unknown;
  viewerCanUnresolve?: unknown;
  comments?: { nodes?: { databaseId?: unknown }[] | null } | null;
}

interface GqlThreadsPage {
  repository?: {
    pullRequest?: {
      reviewThreads?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: GqlThread[] | null } | null;
    } | null;
  } | null;
}

function toThreadState(node: GqlThread | null | undefined): ReviewThreadState | undefined {
  const root = node?.comments?.nodes?.[0]?.databaseId;
  if (!node || typeof node.id !== 'string' || !/^[\w=-]{1,200}$/.test(node.id) || typeof root !== 'number') return undefined;
  return {
    id: node.id,
    rootCommentId: root,
    resolved: node.isResolved === true,
    canResolve: node.viewerCanResolve === true,
    canUnresolve: node.viewerCanUnresolve === true,
  };
}

/** Re-throws a 422 with the action it refused, so the message can be specific. */
async function tagRejected<T>(request: Promise<T>, action: RejectedAction): Promise<T> {
  try {
    return await request;
  } catch (err) {
    if (err instanceof RejectedError && err.action === undefined) throw new RejectedError(err.message, action);
    throw err;
  }
}

function toPerson(user: GhUser | null | undefined): Person | undefined {
  return user ? { login: user.login, id: user.id } : undefined;
}

function toSummary(p: GhPull): ProposalSummary {
  return {
    number: p.number,
    title: p.title,
    author: toPerson(p.user),
    updatedAt: p.updated_at,
    draft: p.draft === true,
    htmlUrl: githubUrl(p.html_url),
  };
}

function toProposal(p: GhPull): Proposal {
  return {
    ...toSummary(p),
    body: p.body ?? '',
    state: p.merged_at ? 'merged' : p.state,
    headSha: p.head.sha,
    headBranch: p.head.ref,
    sameRepo: p.head.repo?.full_name === p.base.repo.full_name,
    baseBranch: p.base.ref,
    mergeable: p.mergeable ?? null,
    mergeableState: p.mergeable_state ?? 'unknown',
    requestedReviewers: (p.requested_reviewers ?? []).map((u) => ({ login: u.login, id: u.id })),
    assignees: (p.assignees ?? []).map((u) => ({ login: u.login, id: u.id })),
  };
}

function toComment(c: GhComment): ReviewComment {
  return {
    id: c.id,
    inReplyToId: c.in_reply_to_id,
    author: toPerson(c.user),
    body: c.body,
    path: c.path,
    line: c.line ?? null,
    startLine: c.start_line ?? null,
    side: c.side ?? 'RIGHT',
    diffHunk: c.diff_hunk,
    subjectType: c.subject_type === 'file' ? 'file' : 'line',
    createdAt: c.created_at,
    htmlUrl: githubUrl(c.html_url),
  };
}

/** GitHub's position fields for a line or a range on one side of the diff. */
function toPosition(c: NewComment) {
  const position: Record<string, unknown> = { line: c.line, side: c.side };
  if (c.startLine !== undefined && c.startLine !== c.line) {
    position.start_line = c.startLine;
    position.start_side = c.side;
  }
  return position;
}

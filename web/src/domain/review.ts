import type { FileChange, Repository } from './repo';

// Review of proposals (GitHub pull requests). Every text field below comes from
// other people and is untrusted: render it as text, never as HTML.

export interface Person {
  login: string;
  id: number;
}

/** GitHub's state of one submitted review. */
export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed';

/** What a reviewer currently says about a proposal. */
export type ReviewerStatus = 'pending' | ReviewState;

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export type DiffSide = 'LEFT' | 'RIGHT';

export interface ProposalSummary {
  number: number;
  title: string;
  author?: Person;
  updatedAt: string;
  draft: boolean;
  /** https://github.com/... link, or undefined when GitHub sent something else. */
  htmlUrl?: string;
}

export interface Proposal extends ProposalSummary {
  body: string;
  state: 'open' | 'closed' | 'merged';
  headSha: string;
  headBranch: string;
  /** True when the head branch lives in the opened repository (not a fork). */
  sameRepo: boolean;
  baseBranch: string;
  /** GitHub computes this in the background; null means "not known yet". */
  mergeable: boolean | null;
  /** GitHub's `mergeable_state`, for example `clean`, `blocked`, `dirty`. */
  mergeableState: string;
  requestedReviewers: Person[];
  assignees: Person[];
}

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff hunks; missing for binary files and very large diffs. */
  patch?: string;
}

export interface ReviewComment {
  id: number;
  inReplyToId?: number;
  author?: Person;
  body: string;
  path: string;
  /** Line in the current diff; null when the comment is outdated or about the whole file. */
  line: number | null;
  startLine: number | null;
  side: DiffSide;
  /** Diff context ending at the commented line, as GitHub stored it. */
  diffHunk: string;
  /** `file` for a comment on the whole file rather than on lines. */
  subjectType: 'line' | 'file';
  createdAt: string;
  htmlUrl?: string;
}

export interface Review {
  id: number;
  author?: Person;
  state: ReviewState | 'pending';
  body: string;
  submittedAt?: string;
}

/** A line comment that is not sent yet: a single comment or part of a review. */
export interface NewComment {
  path: string;
  line: number;
  side: DiffSide;
  /** First line of a multi-line comment, on the same side. */
  startLine?: number;
  body: string;
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';

export interface ReviewSubmission {
  event: ReviewEvent;
  body: string;
  /** The head the reviewer looked at. */
  commitId: string;
  comments: NewComment[];
}

/** What the signed-in user may do in a repository. */
export interface RepoAccess {
  canPush: boolean;
  /** Repository admin: galley shows project settings. Not a galley permission of its own. */
  admin: boolean;
  /** Merge methods the repository settings allow. */
  mergeMethods: MergeMethod[];
}

/** GitHub's resolution state of one review thread (GraphQL `PullRequestReviewThread`). */
export interface ReviewThreadState {
  /** GraphQL node id, for resolveReviewThread / unresolveReviewThread. */
  id: string;
  /** REST id of the thread's first comment, to match `ReviewComment.id`. */
  rootCommentId: number;
  resolved: boolean;
  /** GitHub's own check (`viewerCanResolve`), so galley never guesses the permission. */
  canResolve: boolean;
  canUnresolve: boolean;
}

export interface ProposalFiles {
  files: string[];
  truncated: boolean;
}

/** Port for reviewing proposals. Kept apart from RepoGateway, which is about editing. */
export interface ReviewGateway {
  /** The signed-in user. */
  currentUser(): Promise<Person>;
  listProposals(repo: Repository): Promise<ProposalSummary[]>;
  getProposal(repo: Repository, number: number): Promise<Proposal>;
  listChangedFiles(repo: Repository, number: number): Promise<ChangedFile[]>;
  listReviewComments(repo: Repository, number: number): Promise<ReviewComment[]>;
  listReviews(repo: Repository, number: number): Promise<Review[]>;
  /** Whether each review thread is resolved, and whether the user may change that. */
  listReviewThreads(repo: Repository, number: number): Promise<ReviewThreadState[]>;
  /** Resolves (true) or reopens (false) a review thread by its node id. */
  setThreadResolved(repo: Repository, threadId: string, resolved: boolean): Promise<ReviewThreadState>;
  /** File paths at a commit, to preview a proposal's version. */
  listFiles(repo: Repository, ref: string): Promise<ProposalFiles>;
  addComment(repo: Repository, number: number, commitId: string, comment: NewComment): Promise<ReviewComment>;
  /** Replies to the first comment of a thread. */
  reply(repo: Repository, number: number, rootCommentId: number, body: string): Promise<ReviewComment>;
  submitReview(repo: Repository, number: number, review: ReviewSubmission): Promise<void>;
  access(repo: Repository): Promise<RepoAccess>;
  /** People who can be asked to review or be assigned. */
  listCandidates(repo: Repository): Promise<Person[]>;
  requestReviewers(repo: Repository, number: number, logins: string[]): Promise<void>;
  removeReviewers(repo: Repository, number: number, logins: string[]): Promise<void>;
  addAssignees(repo: Repository, number: number, logins: string[]): Promise<void>;
  removeAssignees(repo: Repository, number: number, logins: string[]): Promise<void>;
  /**
   * Merges only if the proposal head is still `sha`. Throws `ConflictError` when
   * the head moved and `NotMergeableError` when GitHub refuses the merge.
   */
  merge(repo: Repository, number: number, sha: string, method: MergeMethod): Promise<void>;
  /**
   * Adds one commit on top of `expectedHeadSha` to the proposal's head branch in
   * the same repository, fast-forward only. Throws `ConflictError` if it moved.
   */
  commitToProposal(
    repo: Repository,
    proposal: Pick<Proposal, 'headBranch' | 'sameRepo'>,
    changes: FileChange[],
    message: string,
    expectedHeadSha: string,
  ): Promise<string>;
}

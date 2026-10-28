import {
  ConflictError,
  NotMergeableError,
  RejectedError,
  SuggestionMismatchError,
  type MergeMethod,
  type RejectedAction,
  type ReviewerStatus,
} from '../domain';
import { describeError } from '../workspace/model';
import type { OverallReview } from './status';

// Words for people who do not use git: a pull request is a "proposal".

export const REVIEWER_LABEL: Record<ReviewerStatus, string> = {
  pending: 'Waiting for review',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  commented: 'Commented',
  dismissed: 'Review dismissed',
};

export const OVERALL_LABEL: Record<OverallReview, string> = {
  changes_requested: 'Changes requested',
  approved: 'Approved',
  pending: 'Waiting for review',
  commented: 'Commented',
  none: 'No reviews yet',
};

export const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Keep every change separately (merge commit)',
  squash: 'Combine into one change (squash)',
  rebase: 'Add each change on top (rebase)',
};

/** GitHub's `mergeable_state` in plain words. */
export function mergeLabel(mergeable: boolean | null, state: string): string {
  if (mergeable === null || state === 'unknown') return 'GitHub is still checking whether this can be merged.';
  switch (state) {
    case 'clean':
    case 'has_hooks':
      return 'Ready to merge.';
    case 'unstable':
      return 'Can be merged, but some checks did not pass.';
    case 'dirty':
      return 'Has conflicts with the main version; resolve them on GitHub first.';
    case 'blocked':
      return 'Blocked by the repository rules (for example required reviews or checks).';
    case 'behind':
      return 'Behind the main version; update it on GitHub first.';
    case 'draft':
      return 'Still a draft.';
    default:
      return 'Cannot be merged right now.';
  }
}

const REJECTED: Record<RejectedAction | 'other', string> = {
  comment: 'GitHub did not accept the comment. Line comments can only be placed on lines shown in the changes.',
  review:
    'GitHub did not accept the review. An overall comment may be needed, or a line comment is not on a line shown in the changes.',
  reviewers:
    'GitHub did not accept this. Only people with access to the repository can be asked to review; ask the owner to add them.',
  assignees: 'GitHub did not accept this. Only people with access to the repository can be assigned; ask the owner to add them.',
  branch:
    "GitHub did not let galley update this proposal's branch; it may be protected. Make the change on GitHub instead.",
  other: 'GitHub did not accept this request. Reload and try again, or open it on GitHub.',
};

/** A failure during review, explained without git terms. */
export function describeReviewError(err: unknown): string {
  if (err instanceof SuggestionMismatchError) {
    return 'The file changed since this suggestion was written, so it cannot be applied automatically. Edit the file instead.';
  }
  if (err instanceof ConflictError) {
    return 'The proposal changed since you opened it. Reload it to see the latest version, then try again.';
  }
  if (err instanceof NotMergeableError) {
    return 'GitHub did not allow the merge (rules, checks or conflicts). Open it on GitHub for details.';
  }
  if (err instanceof RejectedError) return REJECTED[err.action ?? 'other'];
  return describeError(err);
}

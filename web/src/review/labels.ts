import {
  ConflictError,
  NotMergeableError,
  RejectedError,
  SuggestionMismatchError,
  type MergeMethod,
  type ReviewerStatus,
} from '../domain';
import { en, type Messages } from '../i18n/en';
import { describeError } from '../workspace/model';
import type { OverallReview } from './status';

// Words for people who do not use git: a pull request is a "proposal". The
// texts live in the message catalog (`t.labels`, `t.errors`).

export const reviewerLabel = (status: ReviewerStatus, t: Messages = en): string => t.labels.reviewer[status];

export const overallLabel = (overall: OverallReview, t: Messages = en): string => t.labels.overall[overall];

export const methodLabel = (method: MergeMethod, t: Messages = en): string => t.labels.method[method];

/** GitHub's `mergeable_state` in plain words. */
export function mergeLabel(mergeable: boolean | null, state: string, t: Messages = en): string {
  const m = t.labels.merge;
  if (mergeable === null || state === 'unknown') return m.checking;
  switch (state) {
    case 'clean':
    case 'has_hooks':
      return m.ready;
    case 'unstable':
      return m.unstable;
    case 'dirty':
      return m.dirty;
    case 'blocked':
      return m.blocked;
    case 'behind':
      return m.behind;
    case 'draft':
      return m.draft;
    default:
      return m.other;
  }
}

/** A failure during review, explained without git terms. */
export function describeReviewError(err: unknown, t: Messages = en): string {
  const m = t.errors;
  if (err instanceof SuggestionMismatchError) return m.suggestionMismatch;
  if (err instanceof ConflictError) return m.proposalChanged;
  if (err instanceof NotMergeableError) return m.notMergeable;
  if (err instanceof RejectedError) return m.rejected[err.action ?? 'other'];
  return describeError(err, t);
}

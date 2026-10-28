import type { Person, Proposal, RepoAccess, Review, ReviewerStatus } from '../domain';

export interface ReviewerRow {
  person: Person;
  status: ReviewerStatus;
}

/**
 * Each reviewer's current position. A pending request wins (GitHub resets a
 * re-requested review); otherwise the latest approval, request for changes or
 * dismissal counts, and plain comments only when there is nothing else.
 */
export function reviewerStatuses(requested: readonly Person[], reviews: readonly Review[]): ReviewerRow[] {
  const rows = new Map<string, ReviewerRow>();
  for (const person of requested) rows.set(person.login, { person, status: 'pending' });
  for (const review of reviews) {
    const person = review.author;
    // A pending review is a draft only its author can see.
    if (!person || review.state === 'pending' || requested.some((p) => p.login === person.login)) continue;
    const row = rows.get(person.login);
    if (!row) rows.set(person.login, { person, status: review.state });
    else if (review.state !== 'commented') row.status = review.state;
  }
  return [...rows.values()];
}

export type OverallReview = 'changes_requested' | 'approved' | 'pending' | 'commented' | 'none';

export function overallReview(rows: readonly ReviewerRow[]): OverallReview {
  const has = (s: ReviewerStatus) => rows.some((r) => r.status === s);
  if (has('changes_requested')) return 'changes_requested';
  if (has('approved')) return 'approved';
  if (has('pending')) return 'pending';
  if (has('commented')) return 'commented';
  return 'none';
}

// `blocked` means rules or required checks stop the merge; galley never bypasses them.
const MERGEABLE_STATES = new Set(['clean', 'unstable', 'has_hooks']);

/** Whether to offer the Merge button. GitHub still checks everything on merge. */
export function canMerge(proposal: Proposal, access: RepoAccess): boolean {
  return (
    proposal.state === 'open' &&
    !proposal.draft &&
    proposal.mergeable === true &&
    MERGEABLE_STATES.has(proposal.mergeableState) &&
    access.canPush &&
    access.mergeMethods.length > 0
  );
}

/** Returns the URL only if it is an https://github.com link. */
export function githubUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.origin === 'https://github.com' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

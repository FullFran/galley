import { describe, expect, it } from 'vitest';
import type { Proposal, Review } from '../domain';
import { canMerge, githubUrl, overallReview, reviewerStatuses } from './status';

const ana = { login: 'ana', id: 1 };
const ben = { login: 'ben', id: 2 };
const cy = { login: 'cy', id: 3 };
const review = (author: typeof ana, state: Review['state'], id: number): Review => ({ id, author, state, body: '' });

describe('reviewerStatuses', () => {
  it('shows requested reviewers as pending and others by their latest decisive review', () => {
    const statuses = reviewerStatuses(
      [ana],
      [
        review(ana, 'approved', 1),
        review(ben, 'changes_requested', 2),
        review(ben, 'commented', 3),
        review(cy, 'commented', 4),
        review(cy, 'pending', 5),
      ],
    );

    expect(statuses).toEqual([
      { person: ana, status: 'pending' },
      { person: ben, status: 'changes_requested' },
      { person: cy, status: 'commented' },
    ]);
  });

  it('lets a later approval replace a request for changes', () => {
    const statuses = reviewerStatuses([], [review(ben, 'changes_requested', 1), review(ben, 'approved', 2)]);
    expect(statuses).toEqual([{ person: ben, status: 'approved' }]);
    expect(overallReview(statuses)).toBe('approved');
  });

  it('summarises the strongest state', () => {
    expect(overallReview([{ person: ana, status: 'approved' }, { person: ben, status: 'changes_requested' }])).toBe(
      'changes_requested',
    );
    expect(overallReview([{ person: ana, status: 'pending' }])).toBe('pending');
    expect(overallReview([])).toBe('none');
  });
});

const proposal = (extra: Partial<Proposal> = {}): Proposal => ({
  number: 1,
  title: 't',
  updatedAt: '',
  draft: false,
  body: '',
  state: 'open',
  headSha: 'h',
  headBranch: 'galley/ana',
  sameRepo: true,
  baseBranch: 'main',
  mergeable: true,
  mergeableState: 'clean',
  requestedReviewers: [],
  assignees: [],
  ...extra,
});
const push = { canPush: true, admin: false, mergeMethods: ['squash' as const] };

describe('canMerge', () => {
  it('needs a mergeable open proposal and push access', () => {
    expect(canMerge(proposal(), push)).toBe(true);
    expect(canMerge(proposal({ mergeableState: 'unstable' }), push)).toBe(true);
    expect(canMerge(proposal(), { canPush: false, admin: false, mergeMethods: ['squash'] })).toBe(false);
    expect(canMerge(proposal(), { canPush: true, admin: false, mergeMethods: [] })).toBe(false);
    expect(canMerge(proposal({ mergeable: null }), push)).toBe(false);
    expect(canMerge(proposal({ mergeable: false, mergeableState: 'dirty' }), push)).toBe(false);
    expect(canMerge(proposal({ mergeableState: 'blocked' }), push)).toBe(false);
    expect(canMerge(proposal({ draft: true }), push)).toBe(false);
    expect(canMerge(proposal({ state: 'merged' }), push)).toBe(false);
  });
});

describe('githubUrl', () => {
  it('keeps only https://github.com links', () => {
    expect(githubUrl('https://github.com/o/p/pull/1')).toBe('https://github.com/o/p/pull/1');
    expect(githubUrl('javascript:alert(1)')).toBeUndefined();
    expect(githubUrl('https://github.com.evil.test/x')).toBeUndefined();
    expect(githubUrl('http://github.com/x')).toBeUndefined();
    expect(githubUrl(undefined)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { RejectedError } from '../domain';
import { describeReviewError } from './labels';

describe('describeReviewError for 422', () => {
  it('explains each refused action accurately', () => {
    expect(describeReviewError(new RejectedError('x', 'comment'))).toMatch(/lines shown in the changes/);
    expect(describeReviewError(new RejectedError('x', 'review'))).toMatch(/did not accept the review/);
    expect(describeReviewError(new RejectedError('x', 'reviewers'))).toMatch(/asked to review/);
    expect(describeReviewError(new RejectedError('x', 'assignees'))).toMatch(/assigned/);
    expect(describeReviewError(new RejectedError('x', 'branch'))).toMatch(/protected/);
    expect(describeReviewError(new RejectedError('x'))).not.toMatch(/review|assign/);
  });
});

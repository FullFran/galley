import { useCallback, useEffect, useState } from 'preact/hooks';
import { AuthRequiredError, type RepoGateway, type Repository, type ReviewGateway } from '../domain';
import { describeReviewError, mergeLabel } from '../review/labels';
import { overallReview, reviewerStatuses } from '../review/status';
import { ProposalList, type ProposalRow } from '../ui/review/ProposalList';
import { ProposalDetail } from './ProposalDetail';

export interface ProposalsProps {
  repos: RepoGateway;
  reviews: ReviewGateway;
  repo: Repository;
  onAuthRequired: () => void;
}

/** How many proposals get their review and merge state looked up for the list. */
const DETAILED = 30;

/** Open proposals of a repository, and the one being reviewed. */
export function Proposals({ repos, reviews, repo, onAuthRequired }: ProposalsProps) {
  const [rows, setRows] = useState<ProposalRow[]>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState<number>();
  const [attempt, setAttempt] = useState(0);

  const fail = useCallback(
    (err: unknown) => (err instanceof AuthRequiredError ? onAuthRequired() : setError(describeReviewError(err))),
    [onAuthRequired],
  );

  useEffect(() => {
    if (open !== undefined) return;
    let active = true;
    setError(undefined);
    reviews.listProposals(repo).then((list) => {
      if (!active) return;
      setRows(list.map((summary) => ({ summary })));
      // Review and merge state need one request each; fill them in as they arrive.
      for (const summary of list.slice(0, DETAILED)) {
        Promise.all([reviews.getProposal(repo, summary.number), reviews.listReviews(repo, summary.number)])
          .then(([proposal, list]) => {
            if (!active) return;
            const overall = overallReview(reviewerStatuses(proposal.requestedReviewers, list));
            const merge = mergeLabel(proposal.mergeable, proposal.draft ? 'draft' : proposal.mergeableState);
            setRows((prev) => prev?.map((r) => (r.summary.number === summary.number ? { ...r, overall, merge } : r)));
          })
          .catch(() => undefined);
      }
    }, (err: unknown) => active && fail(err));
    return () => {
      active = false;
    };
  }, [reviews, repo, open, attempt, fail]);

  if (open !== undefined) {
    return (
      <ProposalDetail
        repos={repos}
        reviews={reviews}
        repo={repo}
        number={open}
        onBack={() => setOpen(undefined)}
        onAuthRequired={onAuthRequired}
      />
    );
  }
  return (
    <main class="page page-wide">
      <h2>Proposals</h2>
      <p class="muted">Changes people propose for {repo.fullName}. Open one to read it, comment and review.</p>
      {error ? (
        <div class="banner banner-error" role="alert">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : rows ? (
        <ProposalList rows={rows} onOpen={setOpen} />
      ) : (
        <p class="muted">Loading proposals…</p>
      )}
    </main>
  );
}

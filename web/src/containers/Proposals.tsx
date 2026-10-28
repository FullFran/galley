import { useCallback, useEffect, useState } from 'preact/hooks';
import { AuthRequiredError, type RepoGateway, type Repository, type ReviewGateway } from '../domain';
import { describeReviewError } from '../review/labels';
import { overallReview, reviewerStatuses } from '../review/status';
import { ProposalList, type ProposalRow } from '../ui/review/ProposalList';
import { useT, useTRef } from '../i18n';
import { AppShell, type ShellContext } from '../ui/shell/AppShell';
import { Skeleton } from '../ui/shell/Skeleton';
import { ProposalDetail } from './ProposalDetail';

export interface ProposalsProps {
  repos: RepoGateway;
  reviews: ReviewGateway;
  repo: Repository;
  onAuthRequired: () => void;
  shell: ShellContext;
  /** The proposal shown, from the URL; none for the list. */
  number?: number;
  onOpen: (number: number | undefined) => void;
}

/** How many proposals get their review and merge state looked up for the list. */
const DETAILED = 30;

/** Open proposals of a repository, and the one being reviewed. */
export function Proposals({ repos, reviews, repo, number: open, onOpen, onAuthRequired, shell }: ProposalsProps) {
  const t = useT();
  const tRef = useTRef();
  const [rows, setRows] = useState<ProposalRow[]>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  const fail = useCallback(
    (err: unknown) => (err instanceof AuthRequiredError ? onAuthRequired() : setError(describeReviewError(err, tRef.current))),
    [onAuthRequired, tRef],
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
            // Kept as data, so the label follows a language switch.
            const merge = { mergeable: proposal.mergeable, state: proposal.draft ? 'draft' : proposal.mergeableState };
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
        onBack={() => onOpen(undefined)}
        onAuthRequired={onAuthRequired}
        shell={shell}
      />
    );
  }
  return (
    <AppShell shell={shell} active="proposals" crumbs={[{ label: repo.fullName, onSelect: shell.onRepos, title: t.nav.switchRepo }, t.proposals.title]}>
      <div class="page page-wide">
        <h1>{t.proposals.title}</h1>
        <p class="muted">{t.proposals.intro(repo.fullName)}</p>
        {error ? (
          <div class="notice notice-danger" role="alert">
            <p>{error}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              {t.proposals.tryAgain}
            </button>
          </div>
        ) : rows ? (
          <ProposalList rows={rows} onOpen={onOpen} onEmptyAction={() => shell.onNavigate('contents')} />
        ) : (
          <Skeleton variant="list" lines={3} />
        )}
      </div>
    </AppShell>
  );
}

import type { ProposalSummary } from '../../domain';
import { OVERALL_LABEL } from '../../review/labels';
import type { OverallReview } from '../../review/status';
import { formatDate, GitHubLink } from './GitHubLink';

export interface ProposalRow {
  summary: ProposalSummary;
  /** Filled in once the details arrive. */
  overall?: OverallReview;
  merge?: string;
}

export interface ProposalListProps {
  rows: ProposalRow[];
  onOpen: (number: number) => void;
}

export function ProposalList({ rows, onOpen }: ProposalListProps) {
  if (rows.length === 0) return <p class="muted">There are no open proposals in this repository.</p>;
  return (
    <ul class="proposal-list">
      {rows.map(({ summary, overall, merge }) => (
        <li key={summary.number} class="proposal-row">
          <button type="button" class="proposal-title" onClick={() => onOpen(summary.number)}>
            {summary.title}
          </button>
          <span class="muted">
            #{summary.number}
            {summary.author && ` by ${summary.author.login}`}
            {summary.updatedAt && `, updated ${formatDate(summary.updatedAt)}`}
            {summary.draft && ' (draft)'}
          </span>
          <span class="proposal-state">
            {overall ? OVERALL_LABEL[overall] : '…'}
            {merge && ` · ${merge}`}
          </span>
          <GitHubLink href={summary.htmlUrl} />
        </li>
      ))}
    </ul>
  );
}

import type { ProposalSummary } from '../../domain';
import { useT } from '../../i18n';
import { formatUpdated } from '../../i18n/format';
import { mergeLabel, overallLabel } from '../../review/labels';
import type { OverallReview } from '../../review/status';
import { Icon } from '../shell/icons';
import { GitHubLink } from './GitHubLink';

export interface ProposalRow {
  summary: ProposalSummary;
  /** Filled in once the details arrive. */
  overall?: OverallReview;
  /** GitHub's merge state ('draft' for drafts), shown in words. */
  merge?: { mergeable: boolean | null; state: string };
}

export interface ProposalListProps {
  rows: ProposalRow[];
  onOpen: (number: number) => void;
  /** The one action of the empty state. */
  onEmptyAction?: () => void;
}

const TONE: Record<OverallReview, string> = {
  approved: 'chip chip-ok',
  changes_requested: 'chip chip-danger',
  pending: 'chip chip-warn',
  commented: 'chip',
  none: 'chip',
};

export function ProposalList({ rows, onOpen, onEmptyAction }: ProposalListProps) {
  const t = useT();
  const m = t.proposals;
  if (rows.length === 0) {
    return (
      <div class="empty">
        <Icon name="proposals" class="empty-icon" />
        <h2>{m.emptyTitle}</h2>
        <p>{m.emptyBody}</p>
        {onEmptyAction && (
          <button type="button" class="primary" onClick={onEmptyAction}>
            {m.emptyAction}
          </button>
        )}
      </div>
    );
  }
  return (
    <ul class="row-list proposal-list">
      {rows.map(({ summary, overall, merge }) => {
        const updated = summary.updatedAt ? formatUpdated(summary.updatedAt, t.meta.lang) : '';
        return (
          <li key={summary.number} class="row proposal-row">
            <button type="button" class="row-main proposal-title" onClick={() => onOpen(summary.number)}>
              <span class="row-title">{summary.title}</span>
            </button>
            <span class="muted row-meta">
              #{summary.number}
              {summary.author && ` ${m.by(summary.author.login)}`}
              {updated && `, ${m.updated(updated)}`}
            </span>
            <span class="proposal-state">
              {summary.draft && <span class="chip">{m.draft}</span>}
              {overall ? <span class={TONE[overall]}>{overallLabel(overall, t)}</span> : <span class="chip chip-loading">{m.loadingState}</span>}
              {merge && <span class="muted">{mergeLabel(merge.mergeable, merge.state, t)}</span>}
            </span>
            <GitHubLink href={summary.htmlUrl} />
          </li>
        );
      })}
    </ul>
  );
}

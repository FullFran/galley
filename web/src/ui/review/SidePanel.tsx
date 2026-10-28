import type { MergeMethod, Person, Proposal, RepoAccess, ReviewEvent } from '../../domain';
import { mergeLabel, METHOD_LABEL, REVIEWER_LABEL } from '../../review/labels';
import { canMerge, type ReviewerRow } from '../../review/status';
import { useT, type Messages } from '../../i18n';

export interface PeopleProps {
  reviewers: ReviewerRow[];
  assignees: Person[];
  /** People who can be asked; empty when GitHub did not list them. */
  candidates: Person[];
  canEdit: boolean;
  /** Shown when the controls are hidden. */
  editHint?: string;
  busy: boolean;
  onRequest: (login: string) => void;
  onRemoveReviewer: (login: string) => void;
  onAssign: (login: string) => void;
  onUnassign: (login: string) => void;
}

export function People(props: PeopleProps) {
  const { reviewers, assignees, candidates, canEdit, editHint, busy } = props;
  const pending = new Set(reviewers.filter((r) => r.status === 'pending').map((r) => r.person.login));
  const assigned = new Set(assignees.map((p) => p.login));
  return (
    <section class="side-block" aria-label="Reviewers">
      <h3>Reviewers</h3>
      {reviewers.length === 0 && <p class="muted">Nobody has been asked to review yet.</p>}
      <ul class="people">
        {reviewers.map(({ person, status }) => (
          <li key={person.login}>
            <span>{person.login}</span> <span class={`review-status status-${status}`}>{REVIEWER_LABEL[status]}</span>
            {canEdit && status === 'pending' && (
              <button type="button" class="link" disabled={busy} onClick={() => props.onRemoveReviewer(person.login)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <PersonPicker
          label="Ask someone to review"
          people={candidates.filter((p) => !pending.has(p.login))}
          busy={busy}
          onPick={props.onRequest}
        />
      )}
      <h3>Assigned to</h3>
      {assignees.length === 0 && <p class="muted">Nobody.</p>}
      <ul class="people">
        {assignees.map((person) => (
          <li key={person.login}>
            <span>{person.login}</span>
            {canEdit && (
              <button type="button" class="link" disabled={busy} onClick={() => props.onUnassign(person.login)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <PersonPicker label="Assign someone" people={candidates.filter((p) => !assigned.has(p.login))} busy={busy} onPick={props.onAssign} />
      )}
      {!canEdit && editHint && <p class="muted">{editHint}</p>}
    </section>
  );
}

function PersonPicker({ label, people, busy, onPick }: { label: string; people: Person[]; busy: boolean; onPick: (login: string) => void }) {
  if (people.length === 0) return null;
  return (
    <label class="person-picker">
      {label}
      <select
        disabled={busy}
        value=""
        onChange={(e) => {
          const login = (e.target as HTMLSelectElement).value;
          if (login) onPick(login);
        }}
      >
        <option value="">Choose…</option>
        {people.map((p) => (
          <option key={p.login} value={p.login}>
            {p.login}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface ReviewFormProps {
  event: ReviewEvent;
  body: string;
  pendingCount: number;
  /** The author of a proposal cannot approve it or ask for changes. */
  ownProposal: boolean;
  busy: boolean;
  onEvent: (event: ReviewEvent) => void;
  onBody: (body: string) => void;
  onSubmit: () => void;
}

// Approving or asking for changes is what a review is for, so they come first;
// the send button says what will happen.
const events = (t: Messages): { value: ReviewEvent; label: string; send: string }[] => [
  { value: 'APPROVE', label: t.review.approve, send: t.review.approve },
  { value: 'REQUEST_CHANGES', label: t.review.askChanges, send: t.review.askChanges },
  { value: 'COMMENT', label: t.review.commentOnly, send: t.review.sendComment },
];

export function ReviewForm(props: ReviewFormProps) {
  const t = useT();
  const EVENTS = events(t);
  const { event, body, pendingCount, ownProposal, busy } = props;
  const needsBody = event === 'REQUEST_CHANGES' || (event === 'COMMENT' && pendingCount === 0);
  return (
    <section class="side-block" aria-label="Your review" id="your-review" tabIndex={-1}>
      <h3>Your review</h3>
      <fieldset class="segmented review-events">
        <legend class="visually-hidden">{t.review.decision}</legend>
        {EVENTS.map((e) => (
          <label key={e.value}>
            <input
              type="radio"
              name="review-event"
              value={e.value}
              checked={event === e.value}
              disabled={ownProposal && e.value !== 'COMMENT'}
              onChange={() => props.onEvent(e.value)}
            />{' '}
            {e.label}
          </label>
        ))}
      </fieldset>
      <label>
        Overall comment{needsBody ? '' : ' (optional)'}
        <textarea rows={4} value={body} onInput={(e) => props.onBody((e.target as HTMLTextAreaElement).value)} />
      </label>
      {pendingCount > 0 && (
        <p class="muted">
          {pendingCount} line {pendingCount === 1 ? 'comment' : 'comments'} will be sent with this review.
        </p>
      )}
      <button type="button" class="primary" disabled={busy || (needsBody && body.trim() === '')} onClick={props.onSubmit}>
        {EVENTS.find((e) => e.value === event)?.send ?? 'Send review'}
      </button>
    </section>
  );
}

export interface MergeBoxProps {
  proposal: Proposal;
  access: RepoAccess;
  method: MergeMethod;
  busy: boolean;
  onMethod: (method: MergeMethod) => void;
  onMerge: () => void;
}

export function MergeBox({ proposal, access, method, busy, onMethod, onMerge }: MergeBoxProps) {
  const t = useT();
  if (proposal.state === 'merged') return <p class="notice notice-ok">This proposal has been merged.</p>;
  if (proposal.state === 'closed') return <p class="notice">This proposal is closed.</p>;
  const allowed = canMerge(proposal, access);
  return (
    <section class="side-block" aria-label="Merge">
      <h3>Merge</h3>
      <p>{proposal.draft ? mergeLabel(proposal.mergeable, 'draft') : mergeLabel(proposal.mergeable, proposal.mergeableState)}</p>
      {!access.canPush && <p class="muted">Only people who can change this repository can merge.</p>}
      {access.canPush && access.mergeMethods.length === 0 && (
        <p class="muted">GitHub did not say which merge methods this repository allows. Merge on GitHub instead.</p>
      )}
      {allowed && (
        <>
          <button type="button" class="primary" disabled={busy} onClick={onMerge}>
            Merge
          </button>
          {access.mergeMethods.length > 1 && (
            <details class="merge-options">
              <summary>{t.review.mergeOptions}</summary>
              <label>
                How to merge
                <select value={method} onChange={(e) => onMethod((e.target as HTMLSelectElement).value as MergeMethod)}>
                  {access.mergeMethods.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </option>
                  ))}
                </select>
              </label>
            </details>
          )}
        </>
      )}
    </section>
  );
}

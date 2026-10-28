import type { MergeMethod, Person, Proposal, RepoAccess, ReviewEvent } from '../../domain';
import { mergeLabel, methodLabel, reviewerLabel } from '../../review/labels';
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
  const t = useT();
  const m = t.people;
  const { reviewers, assignees, candidates, canEdit, editHint, busy } = props;
  const pending = new Set(reviewers.filter((r) => r.status === 'pending').map((r) => r.person.login));
  const assigned = new Set(assignees.map((p) => p.login));
  return (
    <section class="side-block" aria-label={m.reviewers}>
      <h3>{m.reviewers}</h3>
      {reviewers.length === 0 && <p class="muted">{m.nobodyAsked}</p>}
      <ul class="people">
        {reviewers.map(({ person, status }) => (
          <li key={person.login}>
            <span>{person.login}</span> <span class={`review-status status-${status}`}>{reviewerLabel(status, t)}</span>
            {canEdit && status === 'pending' && (
              <button type="button" class="link" disabled={busy} onClick={() => props.onRemoveReviewer(person.login)}>
                {m.remove}
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <PersonPicker
          label={m.askSomeone}
          people={candidates.filter((p) => !pending.has(p.login))}
          busy={busy}
          onPick={props.onRequest}
        />
      )}
      <h3>{m.assignedTo}</h3>
      {assignees.length === 0 && <p class="muted">{m.nobody}</p>}
      <ul class="people">
        {assignees.map((person) => (
          <li key={person.login}>
            <span>{person.login}</span>
            {canEdit && (
              <button type="button" class="link" disabled={busy} onClick={() => props.onUnassign(person.login)}>
                {m.remove}
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <PersonPicker label={m.assignSomeone} people={candidates.filter((p) => !assigned.has(p.login))} busy={busy} onPick={props.onAssign} />
      )}
      {!canEdit && editHint && <p class="muted">{editHint}</p>}
    </section>
  );
}

function PersonPicker({ label, people, busy, onPick }: { label: string; people: Person[]; busy: boolean; onPick: (login: string) => void }) {
  const t = useT();
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
        <option value="">{t.people.choose}</option>
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
    <section class="side-block" aria-label={t.review.yourReview} id="your-review" tabIndex={-1}>
      <h3>{t.review.yourReview}</h3>
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
        {t.review.overallComment(!needsBody)}
        <textarea rows={4} value={body} onInput={(e) => props.onBody((e.target as HTMLTextAreaElement).value)} />
      </label>
      {pendingCount > 0 && (
        <p class="muted">{t.review.pendingCount(pendingCount)}</p>
      )}
      <button type="button" class="primary" disabled={busy || (needsBody && body.trim() === '')} onClick={props.onSubmit}>
        {EVENTS.find((e) => e.value === event)?.send ?? t.review.sendReview}
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
  const m = t.merge;
  if (proposal.state === 'merged') return <p class="notice notice-ok">{m.merged}</p>;
  if (proposal.state === 'closed') return <p class="notice">{m.closed}</p>;
  const allowed = canMerge(proposal, access);
  return (
    <section class="side-block" aria-label={m.title}>
      <h3>{m.title}</h3>
      <p>{mergeLabel(proposal.mergeable, proposal.draft ? 'draft' : proposal.mergeableState, t)}</p>
      {!access.canPush && <p class="muted">{m.onlyPush}</p>}
      {access.canPush && access.mergeMethods.length === 0 && <p class="muted">{m.noMethods}</p>}
      {allowed && (
        <>
          <button type="button" class="primary" disabled={busy} onClick={onMerge}>
            {m.button}
          </button>
          {access.mergeMethods.length > 1 && (
            <details class="merge-options">
              <summary>{t.review.mergeOptions}</summary>
              <label>
                {m.howTo}
                <select value={method} onChange={(e) => onMethod((e.target as HTMLSelectElement).value as MergeMethod)}>
                  {access.mergeMethods.map((option) => (
                    <option key={option} value={option}>
                      {methodLabel(option, t)}
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

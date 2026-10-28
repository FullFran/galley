import { useT } from '../../i18n';
import { formatDateTime, formatUpdated } from '../../i18n/format';
import type { DraftShare } from '../../admin/api';
import type { AdminPerson, AllowEntry, AuditEntry, SharedDraftContent } from '../../admin/http';
import { auditActions, filterAudit, formatBytes, remaining, wouldBeBlocked, type AllowValidation, type RevokeState } from '../../admin/model';
import { Modal } from '../shell/Modal';

// Presentational views of the admin panel. Every value from the server is
// untrusted and rendered as text (JSX escapes it); nothing here sets HTML.

export interface PeopleViewProps {
  people: readonly AdminPerson[];
  /** Your login, to mark your own row. */
  me?: string;
  now?: number;
  onRevoke: (person: AdminPerson) => void;
  onOpenProposals: (login: string) => void;
}

export function PeopleView({ people, me, now = Date.now(), onRevoke, onOpenProposals }: PeopleViewProps) {
  const t = useT();
  const m = t.adminPanel.people;
  const lang = t.meta.lang;
  if (people.length === 0) {
    return (
      <div class="empty admin-empty">
        <p>{m.empty}</p>
      </div>
    );
  }
  return (
    <div class="admin-section">
      <p class="muted">{m.lead}</p>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <caption class="visually-hidden">{m.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{m.login}</th>
              <th scope="col">{m.permission}</th>
              <th scope="col">{m.lastSeen}</th>
              <th scope="col">{m.drafts}</th>
              <th scope="col">{m.actions}</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const self = me !== undefined && p.login.toLowerCase() === me.toLowerCase();
              return (
                <tr key={p.userId}>
                  <th scope="row">
                    <span class="admin-login">{p.login}</span> {self && <span class="muted">{m.you}</span>}{' '}
                    {p.blocked && (
                      <span class="chip chip-danger" title={m.blockedHint}>
                        {m.blocked}
                      </span>
                    )}
                  </th>
                  <td>{m.perm[p.permission]}</td>
                  <td>
                    <time dateTime={p.lastSeen} title={formatDateTime(p.lastSeen, lang)}>
                      {formatUpdated(p.lastSeen, lang, now)}
                    </time>
                  </td>
                  <td>
                    {p.drafts.count === 0 ? (
                      <span class="muted">{m.draftsNone}</span>
                    ) : (
                      <>
                        {m.draftsCount(p.drafts.count)} · {formatBytes(p.drafts.bytes)}
                        {p.drafts.oldest && <span class="muted"> · {m.oldest(formatUpdated(p.drafts.oldest, lang, now))}</span>}
                      </>
                    )}
                  </td>
                  <td class="admin-actions">
                    <button type="button" aria-label={m.proposalsOf(p.login)} onClick={() => onOpenProposals(p.login)}>
                      {m.proposals}
                    </button>
                    <button type="button" class="danger" aria-label={m.signOutOf(p.login)} onClick={() => onRevoke(p)}>
                      {m.signOut}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface RevokeDialogProps {
  state: RevokeState;
  /** Shown inside the dialog when the last attempt failed. */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Confirmation for "Sign out of galley": what it ends, what it leaves, and a warning on your own row. */
export function RevokeDialog({ state, error, onConfirm, onCancel }: RevokeDialogProps) {
  const m = useT().adminPanel.revoke;
  if (state.step !== 'confirm' && state.step !== 'busy' && state.step !== 'failed') return null;
  const busy = state.step === 'busy';
  return (
    <Modal open onClose={onCancel} labelledBy="revoke-title" class="admin-dialog">
      <h2 id="revoke-title">{m.title(state.person.login)}</h2>
      <p>{m.body}</p>
      {state.self && (
        <p class="notice notice-warn" role="note">
          {m.self}
        </p>
      )}
      {error && (
        <p class="notice notice-danger" role="alert">
          {error}
        </p>
      )}
      <div class="actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          {m.cancel}
        </button>
        <button type="button" class="primary" onClick={onConfirm} disabled={busy}>
          {busy ? m.busy : state.self ? m.confirmSelf : m.confirm}
        </button>
      </div>
    </Modal>
  );
}

export interface AccessViewProps {
  entries: readonly AllowEntry[];
  people: readonly AdminPerson[];
  login: string;
  githubId: string;
  busy: boolean;
  /** A validation reason, or a message from the server. */
  error?: Extract<AllowValidation, { ok: false }>['reason'] | { message: string };
  onLogin: (value: string) => void;
  onGithubId: (value: string) => void;
  onAdd: () => void;
  onRemove: (entry: AllowEntry) => void;
}

const entryName = (e: AllowEntry) => e.login ?? `#${e.githubId ?? ''}`;

export function AccessView({ entries, people, login, githubId, busy, error, onLogin, onGithubId, onAdd, onRemove }: AccessViewProps) {
  const m = useT().adminPanel.access;
  const blocked = wouldBeBlocked(people, entries);
  const firstEntryBlocks = entries.length === 0 ? people.filter((p) => p.permission !== 'admin').length : 0;
  const message = error === undefined ? undefined : typeof error === 'string' ? m.invalid[error] : error.message;
  return (
    <div class="admin-section">
      <p>{m.lead}</p>
      <p class="muted">{m.admins}</p>
      {entries.length === 0 ? (
        <p class="notice">{m.off}</p>
      ) : (
        <p class={blocked.length ? 'notice notice-warn' : 'notice'}>{blocked.length ? m.blockedNow(blocked.map((p) => p.login).join(', ')) : m.blockedNone}</p>
      )}
      <form
        class="admin-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onAdd();
        }}
      >
        <h2>{m.formTitle}</h2>
        <div class="form-grid">
          <label>
            {m.login}
            <input
              type="text"
              name="login"
              autoComplete="off"
              spellcheck={false}
              maxLength={40}
              value={login}
              aria-invalid={error === 'login' || error === 'empty' || error === 'duplicate' ? true : undefined}
              onInput={(e) => onLogin(e.currentTarget.value)}
            />
          </label>
          <label>
            {m.githubId}
            <input
              type="text"
              name="github_id"
              inputMode="numeric"
              autoComplete="off"
              maxLength={16}
              value={githubId}
              aria-invalid={error === 'id' ? true : undefined}
              onInput={(e) => onGithubId(e.currentTarget.value)}
            />
            <span class="muted field-hint">{m.idHint}</span>
          </label>
        </div>
        {firstEntryBlocks > 0 && <p class="muted">{m.firstEntry(firstEntryBlocks)}</p>}
        {message && (
          <p class="notice notice-danger" role="alert">
            {message}
          </p>
        )}
        <div class="actions">
          <button type="submit" class="primary" disabled={busy}>
            {busy ? m.adding : m.add}
          </button>
        </div>
      </form>
      {entries.length > 0 && (
        <>
          <h2>{m.listTitle}</h2>
          <ul class="admin-list">
            {entries.map((e) => (
              <li key={e.id}>
                <span class="admin-login">{e.login ?? ''}</span>
                {e.githubId !== undefined && <span class="muted"> {m.entryId(e.githubId)}</span>}
                <button type="button" aria-label={m.remove(entryName(e))} onClick={() => onRemove(e)} disabled={busy}>
                  {m.remove(entryName(e))}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export interface SharedDraftsViewProps {
  shares: readonly DraftShare[];
  now?: number;
  onView: (share: DraftShare) => void;
}

const ownerName = (s: DraftShare) => s.owner.login ?? s.owner.userId;

export function SharedDraftsView({ shares, now = Date.now(), onView }: SharedDraftsViewProps) {
  const m = useT().adminPanel.shared;
  if (shares.length === 0) {
    return (
      <div class="empty admin-empty">
        <p>{m.empty}</p>
      </div>
    );
  }
  return (
    <div class="admin-section">
      <p class="muted">{m.lead}</p>
      <div class="admin-table-wrap">
        <table class="admin-table">
          <caption class="visually-hidden">{m.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{m.owner}</th>
              <th scope="col">{m.path}</th>
              <th scope="col">{m.expires}</th>
              <th scope="col">{m.size}</th>
              <th scope="col">
                <span class="visually-hidden">{m.view}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shares.map((s) => {
              const left = remaining(s.expiresAt, now);
              return (
                <tr key={s.id}>
                  <th scope="row">{ownerName(s)}</th>
                  <td>
                    <code>{s.path}</code>
                  </td>
                  <td>{left ? m.left(left.hours, left.minutes) : m.expired}</td>
                  <td>{s.size === undefined ? '' : formatBytes(s.size)}</td>
                  <td>
                    <button type="button" aria-label={m.viewOf(s.path, ownerName(s))} disabled={!left} onClick={() => onView(s)}>
                      {m.view}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface SharedDraftViewerProps {
  draft: SharedDraftContent;
  onClose: () => void;
  onCopy: () => void;
}

/** A shared draft, read-only plain text, under a banner that says the view is logged. */
export function SharedDraftViewer({ draft, onClose, onCopy }: SharedDraftViewerProps) {
  const t = useT();
  const m = t.adminPanel.shared;
  const until = formatDateTime(draft.share.expiresAt, t.meta.lang);
  return (
    <div class="admin-section shared-viewer">
      <p class="notice notice-warn shared-banner" role="status">
        {m.banner(ownerName(draft.share), until)}
      </p>
      <div class="shared-viewer-head">
        <code>{draft.path}</code> <span class="chip">{m.readOnly}</span>
      </div>
      <pre class="shared-text" tabIndex={0} aria-label={m.textLabel(draft.path)} aria-readonly="true">
        {draft.content}
      </pre>
      <p class="muted">{m.copyHint}</p>
      <div class="actions">
        <button type="button" onClick={onClose}>
          {m.close}
        </button>
        <button type="button" class="primary" onClick={onCopy}>
          {m.copy}
        </button>
      </div>
    </div>
  );
}

export interface ActivityViewProps {
  entries: readonly AuditEntry[];
  action: string;
  onAction: (action: string) => void;
}

export function ActivityView({ entries, action, onAction }: ActivityViewProps) {
  const t = useT();
  const m = t.adminPanel.activity;
  const shown = filterAudit(entries, action);
  return (
    <div class="admin-section">
      <p class="muted">{m.lead}</p>
      {entries.length === 0 ? (
        <div class="empty admin-empty">
          <p>{m.empty}</p>
        </div>
      ) : (
        <>
          <label class="admin-filter">
            {m.filter}{' '}
            <select value={action} onChange={(e) => onAction(e.currentTarget.value)}>
              <option value="">{m.all}</option>
              {auditActions(entries).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <div class="admin-table-wrap">
            <table class="admin-table">
              <caption class="visually-hidden">{m.caption}</caption>
              <thead>
                <tr>
                  <th scope="col">{m.who}</th>
                  <th scope="col">{m.what}</th>
                  <th scope="col">{m.target}</th>
                  <th scope="col">{m.when}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => (
                  <tr key={e.id}>
                    <th scope="row">{e.actor.login || e.actor.userId}</th>
                    <td>
                      <code>{e.action}</code>
                    </td>
                    <td>
                      <code>{e.target}</code>
                    </td>
                    <td>
                      <time dateTime={e.at}>{formatDateTime(e.at, t.meta.lang)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { useT } from '../../i18n';
import type { TicketChange, TicketsGateway } from '../../tickets/http';
import {
  CATEGORIES,
  diagnosticsText,
  ISSUES_URL,
  ticketIssueBody,
  ticketSummary,
  TICKET_FILTERS,
  visibleTickets,
  type Ticket,
  type TicketFilter,
} from '../../tickets/model';
import { Modal } from './Modal';

export interface TicketDetailProps {
  ticket: Ticket;
  busy: boolean;
  error: string;
  onChange: (change: TicketChange) => void;
  onCopy: () => void;
}

/** One ticket. All that was reported is shown as text, never as markup. */
export function TicketDetail({ ticket, busy, error, onChange, onCopy }: TicketDetailProps) {
  const t = useT();
  const m = t.tickets;
  const [issue, setIssue] = useState('');
  const category = CATEGORIES.find((c) => c === ticket.category);
  const diagnostics = diagnosticsText(ticket.diagnostics);
  const number = Number(issue);
  return (
    <article class="ticket-detail">
      <h3>{ticket.ref}</h3>
      <p class="muted">
        {category ? m.categories[category] : ticket.category} · {m.statuses[ticket.status]} · {ticket.login} · {new Date(ticket.created).toLocaleString()}
      </p>
      {ticket.githubIssue > 0 && (
        <p>
          <a href={`${ISSUES_URL}/${ticket.githubIssue}`} target="_blank" rel="noopener noreferrer">#{ticket.githubIssue}</a>
        </p>
      )}
      {ticket.unreadable && <p class="notice notice-warn" role="status">{m.unreadable}</p>}
      <h4>{m.description}</h4>
      <p class="ticket-text">{ticket.description}</p>
      {ticket.steps && (
        <>
          <h4>{m.steps}</h4>
          <p class="ticket-text">{ticket.steps}</p>
        </>
      )}
      <p class="muted">{ticket.version} · {ticket.device}</p>
      {diagnostics && (
        <details class="ticket-technical">
          <summary>{m.technical}</summary>
          <pre>{diagnostics}</pre>
        </details>
      )}
      {error && <p class="notice notice-danger" role="alert">{error}</p>}
      <div class="actions">
        {(['new', 'triaged', 'closed'] as const).map((status) => (
          <button key={status} type="button" disabled={busy || ticket.status === status} onClick={() => onChange({ status })}>
            {m.statuses[status]}
          </button>
        ))}
        {!ticket.unreadable && <button type="button" disabled={busy} onClick={onCopy}>{m.copyIssue}</button>}
      </div>
      <div class="actions ticket-link">
        <label>
          {m.issueNumber}
          <input type="number" min={1} step={1} value={issue} onInput={(e) => setIssue(e.currentTarget.value)} />
        </label>
        <button type="button" disabled={busy || !Number.isSafeInteger(number) || number <= 0} onClick={() => onChange({ status: 'issue', githubIssue: number })}>
          {m.linkIssue}
        </button>
      </div>
    </article>
  );
}

export interface TicketInboxProps {
  open: boolean;
  onClose: () => void;
  gateway: Pick<TicketsGateway, 'list' | 'update'>;
}

/** "Tickets": the admins' inbox. The server refuses everyone else whatever this does. */
export function TicketInbox({ open, onClose, gateway }: TicketInboxProps) {
  const t = useT();
  const m = t.tickets;
  const [tickets, setTickets] = useState<Ticket[] | undefined>();
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<TicketFilter>('new');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoadFailed(false);
    setTickets(undefined);
    gateway.list().then(
      (inbox) => {
        if (!live) return;
        setTickets(inbox.tickets);
        setTotal(inbox.total);
      },
      () => {
        if (live) setLoadFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [open, gateway]);

  const shown = visibleTickets(tickets ?? [], filter, query);
  const current = (tickets ?? []).find((x) => x.ref === selected);

  const change = async (ref: string, c: TicketChange) => {
    setBusy(true);
    setError('');
    try {
      const updated = await gateway.update(ref, c);
      setTickets((list) => list?.map((x) => (x.ref === ref ? updated : x)));
    } catch {
      setError(m.errorUpdate);
    } finally {
      setBusy(false);
    }
  };

  const copyIssue = (ticket: Ticket) => {
    setError('');
    globalThis.navigator.clipboard.writeText(ticketIssueBody(ticket)).catch(() => setError(m.errorCopy));
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="tickets-title" class="ticket-inbox">
      <h2 id="tickets-title">{m.inboxTitle}</h2>
      <div class="ticket-filters">
        <label>
          {m.filter}
          <select value={filter} onChange={(e) => setFilter(e.currentTarget.value as TicketFilter)}>
            {TICKET_FILTERS.map((f) => (
              <option key={f} value={f}>{f === 'all' ? m.all : m.statuses[f]}</option>
            ))}
          </select>
        </label>
        <label>
          {m.search}
          <input type="search" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />
        </label>
      </div>
      {loadFailed && <p class="notice notice-danger" role="alert">{m.errorLoad}</p>}
      {!tickets && !loadFailed && <p class="muted" role="status">{m.loading}</p>}
      {tickets && total > tickets.length && <p class="muted">{m.newestOnly(tickets.length, total)}</p>}
      {tickets && shown.length === 0 && <p class="muted">{m.empty}</p>}
      <div class="ticket-panes">
        {shown.length > 0 && (
          <ul class="ticket-list">
            {shown.map((x) => (
              <li key={x.ref}>
                <button type="button" aria-current={x.ref === selected ? 'true' : undefined} onClick={() => { setSelected(x.ref); setError(''); }}>
                  <strong>{x.ref}</strong> <span class="muted">{m.statuses[x.status]}</span>
                  <br />
                  {ticketSummary(x)}
                </button>
              </li>
            ))}
          </ul>
        )}
        {current && <TicketDetail key={current.ref} ticket={current} busy={busy} error={error} onChange={(c) => void change(current.ref, c)} onCopy={() => copyIssue(current)} />}
      </div>
      <div class="actions">
        <button type="button" class="primary" onClick={onClose}>{m.close}</button>
      </div>
    </Modal>
  );
}

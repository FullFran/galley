import { useEffect, useMemo, useState } from 'preact/hooks';
import { VERSION } from '../../shell/credits';
import { AuthRequiredError } from '../../domain';
import { RateLimitedError } from '../../domain/comments';
import { useT, type Messages } from '../../i18n';
import type { TicketsGateway } from '../../tickets/http';
import {
  CATEGORIES,
  clearDraft,
  deviceSummary,
  diagnosticsText,
  EMPTY_DRAFT,
  errorLog,
  loadDraft,
  MAX_DESCRIPTION,
  MAX_STEPS,
  saveDraft,
  snapshot,
  ticketVersion,
  type TicketDraft,
} from '../../tickets/model';
import { Modal } from './Modal';

export interface TicketDialogProps {
  open: boolean;
  onClose: () => void;
  gateway: Pick<TicketsGateway, 'create'>;
}

export interface TicketTechnical {
  version: string;
  device: string;
  diagnostics: Record<string, unknown>;
}

/** Sends a draft, with the technical details when there are any. Without them it sends none at all. */
export function submitTicket(gateway: Pick<TicketsGateway, 'create'>, draft: TicketDraft, technical: TicketTechnical | null): Promise<string> {
  return gateway.create({ ...draft, version: technical?.version ?? '', device: technical?.device ?? '', diagnostics: technical?.diagnostics ?? null });
}

export function sendErrorMessage(error: unknown, t: Messages): string {
  if (error instanceof AuthRequiredError) return t.tickets.errorSignIn;
  if (error instanceof RateLimitedError) return t.tickets.errorRate;
  return t.tickets.errorRetry;
}

function currentTechnical(): TicketTechnical {
  const w = globalThis.window as Window | undefined;
  const nav = globalThis.navigator as Navigator | undefined;
  return {
    version: ticketVersion(VERSION, import.meta.env.VITE_GALLEY_BUILD),
    device: deviceSummary(nav?.userAgent ?? '', nav?.maxTouchPoints ?? 0),
    diagnostics: snapshot({
      hash: w?.location.hash ?? '',
      locale: globalThis.document?.documentElement.lang ?? '',
      viewport: { width: w?.innerWidth ?? 0, height: w?.innerHeight ?? 0 },
      devicePixelRatio: w?.devicePixelRatio ?? 1,
      errors: errorLog.entries(),
    }),
  };
}

/** "Report a problem". The server answers a reference to quote; the draft stays until then. */
export function TicketDialog({ open, onClose, gateway }: TicketDialogProps) {
  const t = useT();
  const m = t.tickets;
  const [draft, setDraft] = useState<TicketDraft>(EMPTY_DRAFT);
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  const [copied, setCopied] = useState(false);
  const technical = useMemo(currentTechnical, [open]);

  useEffect(() => {
    if (!open) return;
    setDraft(loadDraft());
    setError('');
    setSent('');
    setCopied(false);
  }, [open]);

  const edit = (change: Partial<TicketDraft>) => {
    const next = { ...draft, ...change };
    setDraft(next);
    saveDraft(next);
  };

  const send = async () => {
    setBusy(true);
    setError('');
    try {
      setSent(await submitTicket(gateway, draft, attach ? technical : null));
      clearDraft();
      setDraft(EMPTY_DRAFT);
    } catch (e) {
      setError(sendErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    void globalThis.navigator.clipboard.writeText(sent).then(() => setCopied(true), () => undefined);
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="ticket-title" class="ticket-dialog">
      <h2 id="ticket-title">{m.reportTitle}</h2>
      {sent ? (
        <>
          <p role="status">{m.sent}</p>
          <p class="ticket-ref">{sent}</p>
          <p class="muted">{m.sentHint}</p>
          <div class="actions">
            <button type="button" onClick={copy}>{copied ? m.copied : m.copyRef}</button>
            <button type="button" class="primary" onClick={onClose}>{m.close}</button>
          </div>
        </>
      ) : (
        <>
          <p class="muted">{m.reportIntro}</p>
          <label class="ticket-field">
            {m.category}
            <select value={draft.category} onChange={(e) => edit({ category: e.currentTarget.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{m.categories[c]}</option>
              ))}
            </select>
          </label>
          <label class="ticket-field">
            {m.description}
            <textarea rows={5} maxLength={MAX_DESCRIPTION} required value={draft.description} onInput={(e) => edit({ description: e.currentTarget.value })} />
          </label>
          <label class="ticket-field">
            {m.steps}
            <textarea rows={3} maxLength={MAX_STEPS} value={draft.steps} onInput={(e) => edit({ steps: e.currentTarget.value })} />
          </label>
          <label class="switch-row">
            <input type="checkbox" role="switch" class="switch" checked={attach} onChange={(e) => setAttach(e.currentTarget.checked)} />
            {m.attach}
          </label>
          {attach && (
            <details class="ticket-technical">
              <summary>{m.attachShow}</summary>
              <pre>{diagnosticsText({ version: technical.version, device: technical.device, ...technical.diagnostics })}</pre>
            </details>
          )}
          {error && <p class="notice notice-danger" role="alert">{error}</p>}
          <div class="actions">
            <button type="button" class="primary" disabled={busy || draft.description.trim() === ''} onClick={() => void send()}>
              {busy ? m.sending : m.send}
            </button>
            <button type="button" onClick={onClose}>{m.cancel}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

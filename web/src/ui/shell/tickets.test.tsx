import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact-render-to-string';
import { AuthRequiredError, TransientError } from '../../domain';
import { RateLimitedError } from '../../domain/comments';
import { en } from '../../i18n/en';
import { es } from '../../i18n/es';
import { CATEGORIES, STATUSES, type Ticket } from '../../tickets/model';
import { sendErrorMessage, TicketDialog, submitTicket } from './TicketDialog';
import { TicketDetail } from './TicketInbox';

const noop = () => undefined;

describe('TicketDialog', () => {
  it('offers every category in both languages', () => {
    for (const c of CATEGORIES) {
      expect(en.tickets.categories[c]).toBeTruthy();
      expect(es.tickets.categories[c]).toBeTruthy();
    }
    for (const s of STATUSES) {
      expect(en.tickets.statuses[s]).toBeTruthy();
      expect(es.tickets.statuses[s]).toBeTruthy();
    }
    const html = render(<TicketDialog open onClose={noop} gateway={{ create: vi.fn() }} />);
    for (const c of CATEGORIES) expect(html).toContain(en.tickets.categories[c]);
    expect(html).toContain('maxlength="2000"');
  });

  it('attaches the snapshot only when asked to', async () => {
    const create = vi.fn(async () => 'GL-AAAAAA');
    const draft = { category: 'bug', description: ' blank ', steps: '' };
    await expect(submitTicket({ create }, draft, null)).resolves.toBe('GL-AAAAAA');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ category: 'bug', description: ' blank ', diagnostics: null }));
    await submitTicket({ create }, draft, { locale: 'es' });
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ diagnostics: { locale: 'es' } }));
  });

  it('tells the person what to do, and that the text is kept', () => {
    expect(sendErrorMessage(new AuthRequiredError('x'), en)).toBe(en.tickets.errorSignIn);
    expect(sendErrorMessage(new RateLimitedError('x', 2), en)).toBe(en.tickets.errorRate);
    expect(sendErrorMessage(new TransientError('x'), en)).toBe(en.tickets.errorRetry);
    expect(en.tickets.errorRetry).toMatch(/kept/);
  });
});

describe('TicketDetail', () => {
  const ticket: Ticket = {
    ref: 'GL-AAAAAA', login: 'ana', category: 'bug', status: 'new', description: '<img src=x onerror=alert(1)>', steps: 'open it',
    version: 'v', device: 'Firefox', diagnostics: { locale: 'es' }, githubIssue: 12, created: '2026-10-30T10:00:00Z',
  };

  it('shows what was reported as text, with who sent it and its link', () => {
    const html = render(<TicketDetail ticket={ticket} busy={false} error="" onChange={noop} onCopy={noop} />);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    for (const part of ['GL-AAAAAA', 'ana', 'open it', 'Firefox', '#12', 'locale']) expect(html).toContain(part);
    expect(html).toContain('https://github.com/FullFran/galley/issues/12');
  });
});

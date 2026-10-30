import { describe, expect, it } from 'vitest';
import {
  clearDraft,
  deviceSummary,
  diagnosticsText,
  EMPTY_DRAFT,
  loadDraft,
  saveDraft,
  scrub,
  snapshot,
  ticketIssueBody,
  ticketSummary,
  ticketVersion,
  visibleTickets,
  createErrorLog,
  type Ticket,
} from './model';

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  ref: 'GL-AAAAAA',
  login: 'ana',
  category: 'bug',
  status: 'new',
  description: 'The preview is blank\nsecond line',
  steps: 'open chapter two',
  version: '0.0.0+abc',
  device: 'Firefox, Linux',
  diagnostics: { locale: 'es' },
  githubIssue: 0,
  created: '2026-10-30T10:00:00Z',
  unreadable: false,
  ...over,
});

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

describe('the inbox', () => {
  it('filters by status and searches what was written and the reference, ignoring case', () => {
    const a = ticket();
    const b = ticket({ ref: 'GL-BBBBBB', status: 'closed', description: 'Slow typing', steps: '' });
    expect(visibleTickets([a, b], 'all', '')).toEqual([a, b]);
    expect(visibleTickets([a, b], 'closed', '')).toEqual([b]);
    expect(visibleTickets([a, b], 'all', 'SLOW')).toEqual([b]);
    expect(visibleTickets([a, b], 'all', 'gl-aaa')).toEqual([a]);
    expect(visibleTickets([a, b], 'all', 'chapter')).toEqual([a]);
    expect(visibleTickets([a, b], 'new', 'slow')).toEqual([]);
  });

  it('summarises a ticket with its first line, cut short', () => {
    expect(ticketSummary(ticket())).toBe('The preview is blank');
    expect(ticketSummary(ticket({ description: 'x'.repeat(100) }), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('shows diagnostics as text, or nothing when none came', () => {
    expect(diagnosticsText(null)).toBe('');
    expect(diagnosticsText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it('renders an issue body whose reported text stays inert', () => {
    const body = ticketIssueBody(ticket({ description: 'see ~~~ @someone <b>', steps: '' }));
    expect(body).toContain('**GL-AAAAAA**');
    expect(body).toContain('~~~text\nsee ~ ~ ~ @someone <b>\n~~~');
    expect(body).toContain('_(empty)_');
    expect(body).toContain('"locale": "es"');
    expect(body).not.toContain('ana');
  });
});

describe('the technical snapshot', () => {
  it('scrubs what could point at a person or a paper', () => {
    const out = scrub('failed https://x.io/a?token=1 for me@uni.es at 10.0.0.1 in chapters/two.qmd and thesis.tex');
    expect(out).not.toMatch(/token=1|me@uni|10\.0\.0\.1|chapters|two\.qmd|thesis\.tex/);
  });

  it('keeps a short list of the latest errors', () => {
    const log = createErrorLog(2);
    log.record(new TypeError('one'));
    log.record(new TypeError('two me@uni.es'));
    log.record(new TypeError('three'));
    expect(log.entries()).toEqual(['TypeError: two [email]', 'TypeError: three']);
    log.record(new TypeError('x'.repeat(500)));
    expect(log.entries()[1]?.length).toBeLessThanOrEqual(240);
  });

  it('keeps the message only of errors the engine writes, because galley errors quote file names', () => {
    const log = createErrorLog();
    for (const leak of ['analysis.Rmd is too large to open', 'thesis draft.qmd is too large', 'README is not a file', 'C:\\Users\\ana\\thesis']) {
      log.record(new Error(leak));
      log.record(leak);
    }
    log.record(new SyntaxError('Unexpected token, "my secret title" is not valid JSON'));
    expect(log.entries().join(' ')).not.toMatch(/analysis|thesis|README|ana|secret/);
    expect(log.entries().at(-1)).toBe('SyntaxError');
    expect(log.entries()[0]).toBe('Error');
  });

  it('names where an error happened by the script file only', () => {
    const log = createErrorLog();
    log.record(new TypeError('x is not a function'), 'https://galley.example/assets/index-AbC123.js?v=1', 88);
    log.record(new Error('no'), 'https://galley.example/#/r/acme/thesis.qmd', 3);
    expect(log.entries()).toEqual(['TypeError: x is not a function @ index-AbC123.js:88', 'Error']);
  });

  it('holds an allowlist of fields and only the kind of screen', () => {
    const data = snapshot({
      hash: '#/r/secret-owner/secret-paper/f/chapter.qmd',
      locale: 'es',
      viewport: { width: 480, height: 300 },
      devicePixelRatio: 3,
      errors: ['boom'],
    });
    expect(data).toEqual({ screen: 'workspace', locale: 'es', viewport: '480x300', pixelRatio: 3, errors: ['boom'] });
    expect(JSON.stringify(data)).not.toContain('secret');
  });

  it('summarises the device, never the full user agent', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
    expect(deviceSummary(ua, 0)).toBe('Firefox, Linux');
    expect(deviceSummary('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0', 0)).toBe('Edge, Windows');
    expect(deviceSummary('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', 5)).toBe('Safari, iOS, touch');
    expect(deviceSummary('', 0)).toBe('unknown');
  });

  it('names the build next to the version', () => {
    expect(ticketVersion('1.2.3', 'abcdef0123456789abcdef')).toBe('1.2.3+abcdef012345');
    expect(ticketVersion('1.2.3', undefined)).toBe('1.2.3+dev');
  });
});

describe('the draft', () => {
  it('survives a reload until it is sent', () => {
    const store = memoryStore();
    const draft = { category: 'preview', description: 'half a thought', steps: '' };
    saveDraft(draft, store);
    expect(loadDraft(store)).toEqual(draft);
    clearDraft(store);
    expect(loadDraft(store)).toEqual(EMPTY_DRAFT);
  });

  it('ignores a stored value it does not recognise, and a broken store', () => {
    const store = memoryStore();
    store.setItem('galley:ticket-draft', 'not json');
    expect(loadDraft(store)).toEqual(EMPTY_DRAFT);
    store.setItem('galley:ticket-draft', '{"category":"lore","description":5}');
    expect(loadDraft(store)).toEqual(EMPTY_DRAFT);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(loadDraft(broken)).toEqual(EMPTY_DRAFT);
    expect(() => saveDraft(EMPTY_DRAFT, broken)).not.toThrow();
    expect(() => clearDraft(broken)).not.toThrow();
  });
});

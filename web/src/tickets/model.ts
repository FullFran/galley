import { parseRoute } from '../shell/route';

// Tickets: what a person reports about galley, and what the deployment's ticket
// admins read (README, "Tickets API"). The technical snapshot is an allowlist:
// nothing here may name a repository, a file or a person, and the person sees
// it before sending.

export const CATEGORIES = ['bug', 'saving', 'preview', 'interface', 'performance', 'suggestion', 'other'] as const;
export const STATUSES = ['new', 'triaged', 'issue', 'closed'] as const;

export type TicketCategory = (typeof CATEGORIES)[number];
export type TicketStatus = (typeof STATUSES)[number];
export type TicketFilter = TicketStatus | 'all';

export const TICKET_FILTERS: readonly TicketFilter[] = [...STATUSES, 'all'];
export const MAX_DESCRIPTION = 2000;
export const MAX_STEPS = 2000;
/** The repository a ticket's GitHub issue lives in. */
export const ISSUES_URL = 'https://github.com/FullFran/galley/issues';

export interface Ticket {
  ref: string;
  login: string;
  category: string;
  status: TicketStatus;
  description: string;
  steps: string;
  version: string;
  device: string;
  diagnostics: unknown;
  githubIssue: number;
  created: string;
  /** A sealed field did not open: the text is empty, the rest can be triaged. */
  unreadable: boolean;
}

export interface TicketInput {
  category: string;
  description: string;
  steps: string;
  version: string;
  device: string;
  diagnostics: unknown;
}

export interface TicketDraft {
  category: string;
  description: string;
  steps: string;
}

/** The tickets a filter and a search show, in the order they came. */
export function visibleTickets(tickets: readonly Ticket[], filter: TicketFilter, query: string): Ticket[] {
  const needle = query.trim().toLowerCase();
  return tickets.filter((t) => {
    if (filter !== 'all' && t.status !== filter) return false;
    if (!needle) return true;
    return [t.ref, t.login, t.description, t.steps].some((field) => field.toLowerCase().includes(needle));
  });
}

/** One row of the list: the first line of the description, cut short. */
export function ticketSummary(ticket: Ticket, length = 60): string {
  const line = (ticket.description.split('\n')[0] ?? '').trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

/** The technical snapshot as readable text, or '' when none came. */
export function diagnosticsText(diagnostics: unknown): string {
  return diagnostics === null || diagnostics === undefined || diagnostics === '' ? '' : JSON.stringify(diagnostics, null, 2);
}

/**
 * A ticket as a GitHub issue body. Reported text goes inside a fence, so
 * mentions, links, HTML and fake headings stay inert. It names no reporter:
 * the issue is public, the ticket is not.
 */
export function ticketIssueBody(t: Ticket): string {
  const fenced = (text: string) => (text ? `~~~text\n${text.replace(/~~~/g, '~ ~ ~')}\n~~~` : '_(empty)_');
  const inline = (text: string) => `\`${text.replace(/`/g, '') || 'unknown'}\``;
  const diagnostics = diagnosticsText(t.diagnostics);
  return [
    `Report **${t.ref}** (category: ${t.category}), received ${t.created.slice(0, 10)}.`,
    `### Description\n${fenced(t.description)}`,
    `### Steps to reproduce\n${fenced(t.steps)}`,
    `### Environment\n- Version: ${inline(t.version)}\n- Device: ${inline(t.device)}`,
    ...(diagnostics ? [`<details><summary>Diagnostics</summary>\n\n\`\`\`json\n${diagnostics}\n\`\`\`\n</details>`] : []),
  ].join('\n\n');
}

const ERROR_ENTRIES = 10;

export interface ErrorLog {
  record(error: unknown, file?: string, line?: number, column?: number): void;
  entries(): readonly string[];
}

// Only the kind and the place are kept. A message can quote a file or a title,
// and no scrubbing catches every name.
const KNOWN_ERRORS: ReadonlySet<string> = new Set(['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError']);
const SCRIPT_FILE = /^[\w.-]+\.js$/;

function errorKind(error: unknown): string {
  return error instanceof Error && KNOWN_ERRORS.has(error.name) ? error.name : 'Error';
}

function errorPlace(file: string | undefined, line: number | undefined, column: number | undefined): string {
  const name = (file ?? '').split(/[?#]/)[0]?.split('/').pop() ?? '';
  if (!SCRIPT_FILE.test(name)) return '';
  return ` @ ${name}${line ? `:${line}` : ''}${line && column ? `:${column}` : ''}`;
}

/** The page's latest errors, kept in memory only. */
export function createErrorLog(size = ERROR_ENTRIES): ErrorLog {
  const entries: string[] = [];
  return {
    record(error, file, line, column) {
      entries.push(errorKind(error) + errorPlace(file, line, column));
      if (entries.length > size) entries.shift();
    },
    entries: () => entries.slice(),
  };
}

/** The errors of this page (see installErrorLog). */
export const errorLog = createErrorLog();

/** Starts listening; `main.tsx` calls it once. */
export function installErrorLog(target: Pick<Window, 'addEventListener'>, log: ErrorLog = errorLog): void {
  target.addEventListener('error', (e) => {
    const event = e as ErrorEvent;
    log.record(event.error ?? event.message, event.filename, event.lineno, event.colno);
  });
  target.addEventListener('unhandledrejection', (e) => log.record((e as PromiseRejectionEvent).reason));
}

export interface SnapshotInput {
  hash: string;
  locale: string;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  errors: readonly string[];
}

/** The technical snapshot. Of the route it keeps the kind of screen, never the repository or the file. */
export function snapshot(env: SnapshotInput): Record<string, unknown> {
  return {
    screen: parseRoute(env.hash).name,
    locale: env.locale,
    viewport: `${env.viewport.width}x${env.viewport.height}`,
    pixelRatio: env.devicePixelRatio,
    errors: [...env.errors],
  };
}

/** Browser, system and touch, never the full user agent. */
export function deviceSummary(userAgent: string, maxTouchPoints: number): string {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : '';
  const system = /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : '';
  const parts = [browser, system, maxTouchPoints > 0 ? 'touch' : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'unknown';
}

/** The version a ticket quotes; the package version alone says nothing. */
export function ticketVersion(version: string, build: string | undefined): string {
  return `${version}+${build ? build.slice(0, 12) : 'dev'}`;
}

type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const DRAFT_KEY = 'galley:ticket-draft';

export const EMPTY_DRAFT: TicketDraft = { category: 'bug', description: '', steps: '' };

function localDrafts(): DraftStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The unsent report of this browser. A failed send or a reload loses nothing. */
export function loadDraft(store: DraftStore | undefined = localDrafts()): TicketDraft {
  try {
    const raw = store?.getItem(DRAFT_KEY);
    if (!raw) return EMPTY_DRAFT;
    const v = JSON.parse(raw) as Partial<TicketDraft> | null;
    const known = CATEGORIES.some((c) => c === v?.category);
    if (!v || !known || typeof v.description !== 'string' || typeof v.steps !== 'string') return EMPTY_DRAFT;
    return { category: v.category as string, description: v.description, steps: v.steps };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function saveDraft(draft: TicketDraft, store: DraftStore | undefined = localDrafts()): void {
  try {
    store?.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // A full or blocked store only costs the draft after a reload.
  }
}

export function clearDraft(store: DraftStore | undefined = localDrafts()): void {
  try {
    store?.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to do: the draft comes back at most once.
  }
}

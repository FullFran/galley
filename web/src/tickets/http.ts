import { GatewayError } from '../domain';
import { createGalleyApi, isRecord, str, type GalleyApiOptions } from '../galley/api';
import { STATUSES, type Ticket, type TicketInput, type TicketStatus } from './model';

// Tickets over galley's own API (README, "Tickets API"). The server decides who
// reads the inbox; `access` only tells the UI whether to offer it.

export interface TicketChange {
  status: TicketStatus;
  githubIssue?: number;
}

export interface TicketInbox {
  tickets: Ticket[];
  total: number;
}

export interface TicketQuery {
  status?: TicketStatus;
  offset?: number;
}

export interface TicketsGateway {
  create(input: TicketInput): Promise<string>;
  access(): Promise<boolean>;
  list(query?: TicketQuery): Promise<TicketInbox>;
  update(ref: string, change: TicketChange): Promise<Ticket>;
}

const REF = /^GL-[A-Z0-9]{6}$/;

function parseTicket(v: unknown): Ticket {
  if (
    !isRecord(v) || !str(v.ref) || !REF.test(v.ref) || !str(v.login) || !str(v.category) || !STATUSES.some((s) => s === v.status) ||
    !str(v.description) || !str(v.steps) || !str(v.version) || !str(v.device) || typeof v.github_issue !== 'number' || !str(v.created)
  ) {
    throw new GatewayError('malformed ticket');
  }
  return {
    ref: v.ref,
    login: v.login,
    category: v.category,
    status: v.status as TicketStatus,
    description: v.description,
    steps: v.steps,
    version: v.version,
    device: v.device,
    diagnostics: v.diagnostics ?? null,
    githubIssue: v.github_issue,
    created: v.created,
    unreadable: v.unreadable === true,
  };
}

export function createHttpTicketsGateway(options: GalleyApiOptions = {}): TicketsGateway {
  const api = createGalleyApi('tickets', options);
  return {
    async create(input) {
      const { data } = await api.send('POST', '/me/tickets', { body: { ...input } });
      if (!isRecord(data) || !str(data.ref) || !REF.test(data.ref)) throw new GatewayError('malformed ticket reference');
      return data.ref;
    },
    async access() {
      const { data } = await api.send('GET', '/me/tickets/access');
      return isRecord(data) && data.admin === true;
    },
    async list({ status, offset } = {}) {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (offset) params.set('offset', String(offset));
      const search = params.toString();
      const query = search ? `?${search}` : '';
      const { data } = await api.send('GET', `/tickets/inbox${query}`);
      if (!isRecord(data) || !Array.isArray(data.tickets) || typeof data.total !== 'number') throw new GatewayError('malformed ticket inbox');
      return { tickets: data.tickets.map(parseTicket), total: data.total };
    },
    async update(ref, change) {
      const body = change.githubIssue ? { status: change.status, github_issue: change.githubIssue } : { status: change.status };
      const { data } = await api.send('PATCH', `/tickets/inbox/${encodeURIComponent(ref)}`, { body });
      return parseTicket(data);
    },
  };
}

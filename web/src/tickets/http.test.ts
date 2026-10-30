import { describe, expect, it, vi } from 'vitest';
import { GatewayError, PermissionError } from '../domain';
import { RateLimitedError } from '../domain/comments';
import { createHttpTicketsGateway } from './http';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const apiTicket = {
  ref: 'GL-AAAAAA', login: 'ana', category: 'bug', status: 'new', description: 'd', steps: '', version: 'v', device: 'x',
  diagnostics: null, github_issue: 0, created: '2026-10-30T10:00:00Z', unreadable: false,
};

function firstCall(fetch: { mock: { calls: Parameters<typeof globalThis.fetch>[] } }) {
  const [call] = fetch.mock.calls;
  if (!call) throw new Error('no request');
  return call;
}

function gateway(response: Response) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
  return { fetch, tickets: createHttpTicketsGateway({ apiBase: 'https://api.test', fetch }) };
}

describe('tickets gateway', () => {
  it('posts a ticket with the session and the CSRF header, and returns the reference', async () => {
    const { fetch, tickets } = gateway(json(201, { ref: 'GL-AAAAAA' }));
    const input = { category: 'bug', description: 'd', steps: 's', version: 'v', device: 'x', diagnostics: { locale: 'es' } };
    await expect(tickets.create(input)).resolves.toBe('GL-AAAAAA');
    const [url, init] = firstCall(fetch);
    expect(url).toBe('https://api.test/api/galley/me/tickets');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['X-Galley-CSRF']).toBe('1');
    expect(JSON.parse(init?.body as string)).toEqual(input);
  });

  it('refuses a malformed reference', async () => {
    await expect(gateway(json(201, { ref: '<b>' })).tickets.create({ category: 'bug', description: 'd', steps: '', version: '', device: '', diagnostics: null })).rejects.toBeInstanceOf(GatewayError);
  });

  it('reads access as a plain yes or no', async () => {
    await expect(gateway(json(200, { admin: true })).tickets.access()).resolves.toBe(true);
    await expect(gateway(json(200, { admin: 'yes' })).tickets.access()).resolves.toBe(false);
  });

  it('parses the inbox', async () => {
    const { fetch, tickets } = gateway(json(200, { tickets: [apiTicket], total: 3 }));
    const out = await tickets.list();
    expect(firstCall(fetch)[0]).toBe('https://api.test/api/galley/tickets/inbox');
    expect(out.total).toBe(3);
    expect(out.tickets[0]).toMatchObject({ ref: 'GL-AAAAAA', githubIssue: 0, diagnostics: null });
  });

  it('refuses a malformed inbox', async () => {
    await expect(gateway(json(200, { tickets: [{ ref: 1 }], total: 1 })).tickets.list()).rejects.toBeInstanceOf(GatewayError);
  });

  it('patches a ticket, sending the link only when given', async () => {
    const { fetch, tickets } = gateway(json(200, { ...apiTicket, status: 'closed' }));
    await expect(tickets.update('GL-AAAAAA', { status: 'closed' })).resolves.toMatchObject({ status: 'closed' });
    const [url, init] = firstCall(fetch);
    expect(url).toBe('https://api.test/api/galley/tickets/inbox/GL-AAAAAA');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ status: 'closed' });
  });

  it('maps refusals to the domain errors', async () => {
    await expect(gateway(json(403, {})).tickets.list()).rejects.toBeInstanceOf(PermissionError);
    await expect(gateway(json(429, {}, { 'Retry-After': '2' })).tickets.create({ category: 'bug', description: 'd', steps: '', version: '', device: '', diagnostics: null })).rejects.toBeInstanceOf(RateLimitedError);
  });
});

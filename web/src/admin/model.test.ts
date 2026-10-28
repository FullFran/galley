import { describe, expect, it, vi } from 'vitest';
import type { AdminGateway, AdminPerson, AllowEntry } from './http';
import type { DraftShare } from './api';
import { ConfirmSelfError } from './api';
import {
  auditActions,
  confirmRevoke,
  filterAudit,
  formatBytes,
  remaining,
  shareStatus,
  startRevoke,
  validateAllowInput,
  wouldBeBlocked,
} from './model';

const NOW = Date.parse('2026-10-28T12:00:00Z');

const person = (login: string, over: Partial<AdminPerson> = {}): AdminPerson => ({
  userId: `u${login.padEnd(14, '0')}`.slice(0, 15),
  login,
  githubId: login.length,
  permission: 'write',
  firstSeen: '2026-10-01T10:00:00Z',
  lastSeen: '2026-10-28T10:00:00Z',
  blocked: false,
  drafts: { count: 0, bytes: 0 },
  ...over,
});
const entry = (over: Partial<AllowEntry>): AllowEntry => ({ id: 'a00000000000001', createdAt: '2026-10-28T10:00:00Z', ...over });

describe('allowlist input', () => {
  it('accepts a login (with or without @) and an optional numeric id', () => {
    expect(validateAllowInput(' @Ana-B ', '', [])).toEqual({ ok: true, input: { login: 'Ana-B' } });
    expect(validateAllowInput('ana', ' 123 ', [])).toEqual({ ok: true, input: { login: 'ana', githubId: 123 } });
    expect(validateAllowInput('', '123', [])).toEqual({ ok: true, input: { githubId: 123 } });
  });

  it('rejects empty input, malformed logins and ids', () => {
    expect(validateAllowInput('  ', ' ', [])).toEqual({ ok: false, reason: 'empty' });
    for (const bad of ['-ana', 'ana-', 'a--b', 'a b', 'ana_b', 'x'.repeat(40), '<img>']) {
      expect(validateAllowInput(bad, '', [])).toEqual({ ok: false, reason: 'login' });
    }
    for (const bad of ['0', '-1', '1.5', 'abc', '99999999999999999999']) {
      expect(validateAllowInput('ana', bad, [])).toEqual({ ok: false, reason: 'id' });
    }
  });

  it('rejects duplicates by id, else by login ignoring case', () => {
    expect(validateAllowInput('', '7', [entry({ githubId: 7 })])).toEqual({ ok: false, reason: 'duplicate' });
    expect(validateAllowInput('ANA', '', [entry({ login: 'ana' })])).toEqual({ ok: false, reason: 'duplicate' });
    // A login already on the list with a different id is another person (renames).
    expect(validateAllowInput('ana', '8', [entry({ login: 'ana', githubId: 7 })]).ok).toBe(true);
  });

  it('refuses more than 1,000 entries', () => {
    const many = Array.from({ length: 1000 }, (_, i) => entry({ id: String(i), githubId: i + 1 }));
    expect(validateAllowInput('zed', '', many)).toEqual({ ok: false, reason: 'full' });
  });
});

describe('who the allowlist blocks', () => {
  const people = [person('ana'), person('bob', { permission: 'admin' }), person('eve', { githubId: 99 })];

  it('blocks nobody while the list is empty', () => {
    expect(wouldBeBlocked(people, [])).toEqual([]);
  });

  it('blocks everyone not on it except admins; an id entry decides the match', () => {
    expect(wouldBeBlocked(people, [entry({ login: 'ana' })]).map((p) => p.login)).toEqual(['eve']);
    // The id decides: "eve" by login with another id does not let eve in.
    expect(wouldBeBlocked(people, [entry({ login: 'eve', githubId: 5 })]).map((p) => p.login)).toEqual(['ana', 'eve']);
    expect(wouldBeBlocked(people, [entry({ githubId: 99 })]).map((p) => p.login)).toEqual(['ana']);
  });
});

describe('revoking sessions', () => {
  const gateway = (fail?: unknown) => {
    const revokeSessions = vi.fn((...args: [number, string, boolean]) => (args && fail ? Promise.reject(fail) : Promise.resolve()));
    return { gw: { revokeSessions } as unknown as AdminGateway, revokeSessions };
  };

  it('asks to confirm first, marking your own row', () => {
    expect(startRevoke(person('ana'), 'fran')).toEqual({ step: 'confirm', person: person('ana'), self: false });
    expect(startRevoke(person('Fran'), 'fran')).toMatchObject({ step: 'confirm', self: true });
    expect(startRevoke(person('ana'), undefined)).toMatchObject({ self: false });
  });

  it('sends confirm_self only when revoking yourself', async () => {
    const { gw, revokeSessions } = gateway();
    expect(await confirmRevoke(gw, 42, startRevoke(person('ana'), 'fran'))).toEqual({ step: 'done', login: 'ana', self: false });
    expect(await confirmRevoke(gw, 42, startRevoke(person('fran'), 'fran'))).toEqual({ step: 'done', login: 'fran', self: true });
    expect(revokeSessions.mock.calls).toEqual([
      [42, person('ana').userId, false],
      [42, person('fran').userId, true],
    ]);
  });

  it('keeps the person on failure, so the dialog can say why', async () => {
    const err = new ConfirmSelfError('422');
    const { gw } = gateway(err);
    expect(await confirmRevoke(gw, 42, startRevoke(person('ana'), 'fran'))).toEqual({ step: 'failed', person: person('ana'), self: false, error: err });
  });

  it('does nothing unless a confirmation is open', async () => {
    const { gw, revokeSessions } = gateway();
    expect(await confirmRevoke(gw, 42, { step: 'idle' })).toEqual({ step: 'idle' });
    expect(revokeSessions).not.toHaveBeenCalled();
  });
});

describe('activity log', () => {
  const log = [
    { id: '1', actor: { userId: 'u', login: 'fran' }, action: 'allowlist.add', target: 'allow:1', at: '2026-10-28T10:00:00Z' },
    { id: '2', actor: { userId: 'u', login: 'fran' }, action: 'audit.view', target: 'repo', at: '2026-10-28T09:00:00Z' },
    { id: '3', actor: { userId: 'u', login: 'ana' }, action: 'allowlist.add', target: 'allow:2', at: '2026-10-28T08:00:00Z' },
  ];

  it('lists the distinct actions, sorted, and filters by one', () => {
    expect(auditActions(log)).toEqual(['allowlist.add', 'audit.view']);
    expect(filterAudit(log, 'allowlist.add').map((e) => e.id)).toEqual(['1', '3']);
    expect(filterAudit(log, '')).toBe(log);
  });
});

describe('formatting', () => {
  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('says how long a grant has left', () => {
    expect(remaining('2026-10-29T10:30:00Z', NOW)).toEqual({ hours: 22, minutes: 30 });
    expect(remaining('2026-10-28T11:00:00Z', NOW)).toBeUndefined();
    expect(remaining('nope', NOW)).toBeUndefined();
  });
});

describe('owner share status', () => {
  const share = (path: string, expiresAt = '2026-10-29T10:00:00Z'): DraftShare => ({
    id: 's00000000000001',
    repoId: 42,
    path,
    owner: { userId: 'u00000000000001' },
    createdAt: '2026-10-28T10:00:00Z',
    expiresAt,
  });

  it('is shared while an unexpired grant covers the path', () => {
    expect(shareStatus('a.qmd', true, [share('a.qmd')], NOW)).toEqual({ kind: 'on', expiresAt: '2026-10-29T10:00:00Z' });
    expect(shareStatus('a.qmd', true, [share('a.qmd', '2026-10-28T11:00:00Z')], NOW)).toEqual({ kind: 'off' });
    expect(shareStatus('a.qmd', true, [share('b.qmd')], NOW)).toEqual({ kind: 'off' });
  });

  it('needs a server draft to share', () => {
    expect(shareStatus('a.qmd', false, [], NOW)).toEqual({ kind: 'no-draft' });
    // An active grant can always be stopped, draft or not.
    expect(shareStatus('a.qmd', false, [share('a.qmd')], NOW).kind).toBe('on');
  });
});

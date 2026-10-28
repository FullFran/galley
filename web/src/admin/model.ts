import { AuthRequiredError, NotFoundError, PermissionError } from '../domain';
import { LOGIN } from '../shell/route';
import type { DraftShare, DraftSharesGateway } from './api';
import type { AdminGateway, AdminPerson, AllowEntry, AllowInput, AuditEntry } from './http';

// Pure rules of the admin panel and the owner's share toggle, kept apart from
// the components so they are tested without a browser.

const MAX_ALLOW = 1000;
const GITHUB_ID = /^[1-9]\d{0,15}$/;

export type AllowValidation = { ok: true; input: AllowInput } | { ok: false; reason: 'empty' | 'login' | 'id' | 'duplicate' | 'full' };

/** Checks the "add to the allowlist" form: a GitHub login, a numeric id, or both. */
export function validateAllowInput(rawLogin: string, rawId: string, entries: readonly AllowEntry[]): AllowValidation {
  const login = rawLogin.trim().replace(/^@/, '');
  const id = rawId.trim();
  if (!login && !id) return { ok: false, reason: 'empty' };
  if (login && !LOGIN.test(login)) return { ok: false, reason: 'login' };
  if (id && (!GITHUB_ID.test(id) || !Number.isSafeInteger(Number(id)))) return { ok: false, reason: 'id' };
  const githubId = id ? Number(id) : undefined;
  const taken =
    githubId !== undefined
      ? entries.some((e) => e.githubId === githubId)
      : entries.some((e) => e.githubId === undefined && e.login?.toLowerCase() === login.toLowerCase());
  if (taken) return { ok: false, reason: 'duplicate' };
  if (entries.length >= MAX_ALLOW) return { ok: false, reason: 'full' };
  const input: AllowInput = {};
  if (login) input.login = login;
  if (githubId !== undefined) input.githubId = githubId;
  return { ok: true, input };
}

/** The server's rule: an entry with an id matches by id only; otherwise by login. */
function allowed(person: AdminPerson, entries: readonly AllowEntry[]): boolean {
  return entries.some((e) => (e.githubId !== undefined ? e.githubId === person.githubId : e.login?.toLowerCase() === person.login.toLowerCase()));
}

/** Who the allowlist keeps out: nobody while it is empty, never an admin. */
export function wouldBeBlocked(people: readonly AdminPerson[], entries: readonly AllowEntry[]): AdminPerson[] {
  if (entries.length === 0) return [];
  return people.filter((p) => p.permission !== 'admin' && !allowed(p, entries));
}

export type RevokeState =
  | { step: 'idle' }
  | { step: 'confirm'; person: AdminPerson; self: boolean }
  | { step: 'busy'; person: AdminPerson; self: boolean }
  | { step: 'done'; login: string; self: boolean }
  | { step: 'failed'; person: AdminPerson; self: boolean; error: unknown };

/** "Sign out of galley" opens a confirmation first; your own row says so. */
export function startRevoke(person: AdminPerson, me: string | undefined): RevokeState {
  return { step: 'confirm', person, self: me !== undefined && person.login.toLowerCase() === me.toLowerCase() };
}

/** Runs a confirmed revocation; `confirm_self` is sent only for your own sessions. */
export async function confirmRevoke(gateway: AdminGateway, repoId: number, state: RevokeState): Promise<RevokeState> {
  if (state.step !== 'confirm' && state.step !== 'failed') return state;
  const { person, self } = state;
  try {
    await gateway.revokeSessions(repoId, person.userId, self);
    return { step: 'done', login: person.login, self };
  } catch (error) {
    return { step: 'failed', person, self, error };
  }
}

export function auditActions(entries: readonly AuditEntry[]): string[] {
  return [...new Set(entries.map((e) => e.action))].sort();
}

export function filterAudit<T extends AuditEntry>(entries: readonly T[], action: string): readonly T[] {
  return action ? entries.filter((e) => e.action === action) : entries;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Time left until `iso`; undefined once past (or invalid). */
export function remaining(iso: string, now = Date.now()): { hours: number; minutes: number } | undefined {
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  const minutes = Math.floor(ms / 60_000);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/** The owner's share status for one file. */
export type ShareStatus = { kind: 'unavailable' } | { kind: 'loading' } | { kind: 'no-draft' } | { kind: 'off' } | { kind: 'on'; expiresAt: string };

export function shareStatus(path: string, hasDraft: boolean, shares: readonly DraftShare[], now = Date.now()): ShareStatus {
  const active = shares.filter((s) => s.path === path && remaining(s.expiresAt, now)).sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0];
  if (active) return { kind: 'on', expiresAt: active.expiresAt };
  return hasDraft ? { kind: 'off' } : { kind: 'no-draft' };
}

export type ShareNotice = 'shared' | 'stopped' | 'no-draft' | 'forbidden' | 'failed';

/** The menu item's action: share, stop sharing, or explain why it cannot. */
export async function toggleShare(
  gateway: DraftSharesGateway,
  repoId: number,
  path: string,
  status: ShareStatus,
): Promise<{ status: ShareStatus; notice: ShareNotice }> {
  if (status.kind === 'no-draft') return { status, notice: 'no-draft' };
  if (status.kind !== 'on' && status.kind !== 'off') return { status, notice: 'failed' };
  try {
    if (status.kind === 'on') {
      await gateway.unshare(repoId, path);
      return { status: { kind: 'off' }, notice: 'stopped' };
    }
    const share = await gateway.share(repoId, path);
    return { status: { kind: 'on', expiresAt: share.expiresAt }, notice: 'shared' };
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err;
    if (err instanceof NotFoundError) return { status: { kind: 'no-draft' }, notice: 'no-draft' };
    if (err instanceof PermissionError) return { status, notice: 'forbidden' };
    return { status, notice: 'failed' };
  }
}

import { GatewayError } from '../domain';
import { checkId, checkRepo, count, galleyApi, isRecord, parseShare, str, type DraftShare, type GalleyApiOptions, type Json } from './api';

// The admin panel's gateway over the galley Admin API (README, "Admin API").
// Loaded with the admin panel only. Every value is untrusted and rendered as
// plain text; malformed rows are dropped rather than shown.

export type Permission = 'read' | 'write' | 'admin';

export interface AdminPerson {
  userId: string;
  login: string;
  githubId: number;
  /** As last seen by galley. */
  permission: Permission;
  firstSeen: string;
  lastSeen: string;
  /** Kept out by the allowlist. */
  blocked: boolean;
  /** Metadata only: content is never returned. */
  drafts: { count: number; bytes: number; oldest?: string; newest?: string };
}

export interface AllowEntry {
  id: string;
  githubId?: number;
  login?: string;
  createdAt: string;
}

export interface AllowInput {
  login?: string;
  githubId?: number;
}

export interface SharedDraftContent {
  share: DraftShare;
  path: string;
  content: string;
  size: number;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  actor: { userId: string; login: string };
  action: string;
  target: string;
  at: string;
}

export interface AdminGateway {
  people(repoId: number): Promise<AdminPerson[]>;
  revokeSessions(repoId: number, userId: string, confirmSelf: boolean): Promise<void>;
  allowlist(repoId: number): Promise<AllowEntry[]>;
  allow(repoId: number, input: AllowInput): Promise<AllowEntry>;
  disallow(repoId: number, id: string): Promise<void>;
  sharedDrafts(repoId: number): Promise<DraftShare[]>;
  sharedDraft(repoId: number, id: string): Promise<SharedDraftContent>;
  audit(repoId: number): Promise<AuditEntry[]>;
}

const PERMISSIONS: readonly string[] = ['read', 'write', 'admin'];
const optTime = (v: unknown) => (str(v) && v !== '' ? v : undefined);

function parsePerson(v: unknown): AdminPerson | undefined {
  if (!isRecord(v) || !str(v.user_id) || !str(v.login) || v.login === '' || !count(v.github_id)) return undefined;
  if (!str(v.permission) || !PERMISSIONS.includes(v.permission) || !str(v.first_seen) || !str(v.last_seen)) return undefined;
  const d = isRecord(v.drafts) ? v.drafts : {};
  const drafts: AdminPerson['drafts'] = { count: count(d.count) ? d.count : 0, bytes: count(d.bytes) ? d.bytes : 0 };
  const oldest = optTime(d.oldest_updated_at);
  const newest = optTime(d.newest_updated_at);
  if (oldest) drafts.oldest = oldest;
  if (newest) drafts.newest = newest;
  return {
    userId: v.user_id,
    login: v.login,
    githubId: v.github_id,
    permission: v.permission as Permission,
    firstSeen: v.first_seen,
    lastSeen: v.last_seen,
    blocked: v.blocked === true,
    drafts,
  };
}

function parseAllow(v: unknown): AllowEntry | undefined {
  if (!isRecord(v) || !str(v.id) || !str(v.created_at)) return undefined;
  const entry: AllowEntry = { id: v.id, createdAt: v.created_at };
  if (str(v.login) && v.login !== '') entry.login = v.login;
  if (count(v.github_id) && v.github_id > 0) entry.githubId = v.github_id;
  return entry.login || entry.githubId ? entry : undefined;
}

function parseAudit(v: unknown): AuditEntry | undefined {
  if (!isRecord(v) || !str(v.id) || !str(v.action) || !str(v.target) || !str(v.at) || !isRecord(v.actor) || !str(v.actor.user_id)) return undefined;
  return { id: v.id, actor: { userId: v.actor.user_id, login: str(v.actor.login) ? v.actor.login : '' }, action: v.action, target: v.target, at: v.at };
}

function list<T>(data: unknown, key: string, parse: (v: unknown) => T | undefined): T[] {
  if (!isRecord(data) || !Array.isArray(data[key])) throw new GatewayError(`malformed ${key}`);
  return (data[key] as unknown[]).map(parse).filter((x): x is T => x !== undefined);
}

export function createHttpAdminGateway(options: GalleyApiOptions = {}): AdminGateway {
  const send = galleyApi(options);
  const admin = (repoId: number) => `/repos/${checkRepo(repoId)}/admin`;
  return {
    async people(repoId) {
      return list(await send('GET', `${admin(repoId)}/people`), 'people', parsePerson);
    },
    async revokeSessions(repoId, userId, confirmSelf) {
      await send('POST', `${admin(repoId)}/people/${checkId(userId)}/revoke-sessions`, confirmSelf ? { confirm_self: true } : {});
    },
    async allowlist(repoId) {
      return list(await send('GET', `${admin(repoId)}/allowlist`), 'entries', parseAllow);
    },
    async allow(repoId, input) {
      const body: Json = {};
      if (input.login) body.login = input.login;
      if (input.githubId !== undefined) body.github_id = input.githubId;
      const entry = parseAllow(await send('POST', `${admin(repoId)}/allowlist`, body));
      if (!entry) throw new GatewayError('malformed allowlist entry');
      return entry;
    },
    async disallow(repoId, id) {
      await send('DELETE', `${admin(repoId)}/allowlist/${checkId(id)}`);
    },
    async sharedDrafts(repoId) {
      return list(await send('GET', `${admin(repoId)}/shared-drafts`), 'shared_drafts', parseShare);
    },
    async sharedDraft(repoId, id) {
      const data = await send('GET', `${admin(repoId)}/shared-drafts/${checkId(id)}`);
      const share = isRecord(data) ? parseShare(data.share) : undefined;
      if (!isRecord(data) || !share || data.read_only !== true || !str(data.path) || !str(data.content)) throw new GatewayError('malformed shared draft');
      return {
        share,
        path: data.path,
        content: data.content,
        size: count(data.size) ? data.size : data.content.length,
        updatedAt: str(data.updated_at) ? data.updated_at : '',
      };
    },
    async audit(repoId) {
      return list(await send('GET', `${admin(repoId)}/audit`), 'entries', parseAudit);
    },
  };
}

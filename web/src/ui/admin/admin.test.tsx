import { describe, expect, it, vi } from 'vitest';
import { render } from 'preact-render-to-string';
import { NotFoundError, PermissionError } from '../../domain';
import { es } from '../../i18n/es';
import { I18n } from '../../i18n';
import type { DraftShare, DraftSharesGateway } from '../../admin/api';
import type { AdminPerson, AuditEntry, SharedDraftContent } from '../../admin/http';
import { startRevoke, toggleShare } from '../../admin/model';
import { AccessView, ActivityView, PeopleView, RevokeDialog, SharedDraftsView, SharedDraftViewer } from './views';
import { shareMenuItem } from './shareMenu';
import { en } from '../../i18n/en';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const evil = '<img src=x onerror="alert(1)">';
const noop = () => undefined;

const person = (login: string, over: Partial<AdminPerson> = {}): AdminPerson => ({
  userId: 'u00000000000001',
  login,
  githubId: 7,
  permission: 'write',
  firstSeen: '2026-10-01T10:00:00Z',
  lastSeen: '2026-10-28T09:00:00Z',
  blocked: false,
  drafts: { count: 2, bytes: 2048, oldest: '2026-10-20T12:00:00Z', newest: '2026-10-27T10:00:00Z' },
  ...over,
});

const share = (over: Partial<DraftShare> = {}): DraftShare => ({
  id: 's00000000000001',
  repoId: 42,
  path: 'chapters/intro.qmd',
  owner: { userId: 'u00000000000001', login: 'ana' },
  createdAt: '2026-10-28T10:00:00Z',
  expiresAt: '2026-10-29T10:00:00Z',
  size: 12,
  ...over,
});

describe('People', () => {
  const html = render(<PeopleView people={[person('ana'), person('bob', { blocked: true, permission: 'admin' })]} me="fran" now={NOW} onRevoke={noop} onOpenProposals={noop} />);

  it('lists login, permission, last seen and draft metadata, with actions', () => {
    expect(html).toContain('<table');
    expect(html).toContain('ana');
    expect(html).toContain('3 hours ago');
    expect(html).toContain('2 drafts');
    expect(html).toContain('2.0 KB');
    expect(html).toContain('Sign out of galley');
    expect(html).toContain('Open their proposals');
    expect(html).toContain('Blocked');
  });

  it('teaches when nobody used galley yet', () => {
    const empty = render(<PeopleView people={[]} me="fran" now={NOW} onRevoke={noop} onOpenProposals={noop} />);
    expect(empty).not.toContain('<table');
    expect(empty).toContain('Nobody has used galley on this paper yet');
  });

  it('renders logins as text', () => {
    const out = render(<PeopleView people={[person(evil)]} me="fran" now={NOW} onRevoke={noop} onOpenProposals={noop} />);
    expect(out).not.toContain('<img');
  });
});

describe('Sign out of galley dialog', () => {
  it('names the person and says what it does and does not do', () => {
    const html = render(<RevokeDialog state={startRevoke(person('ana'), 'fran')} onConfirm={noop} onCancel={noop} />);
    expect(html).toContain('<dialog');
    expect(html).toContain('Sign ana out of galley?');
    expect(html).toContain('GitHub');
    expect(html).not.toContain('This is you');
  });

  it('warns when it is you', () => {
    const html = render(<RevokeDialog state={startRevoke(person('fran'), 'fran')} onConfirm={noop} onCancel={noop} />);
    expect(html).toContain('This is you');
    expect(html).toContain('Sign myself out');
  });

  it('renders nothing when no confirmation is open', () => {
    expect(render(<RevokeDialog state={{ step: 'idle' }} onConfirm={noop} onCancel={noop} />)).toBe('');
  });
});

describe('Access', () => {
  const base = { login: '', githubId: '', busy: false, onLogin: noop, onGithubId: noop, onAdd: noop, onRemove: noop };

  it('explains that it limits galley, not GitHub, and that the list is off while empty', () => {
    const html = render(<AccessView {...base} entries={[]} people={[person('ana')]} />);
    expect(html).toContain('not GitHub access');
    expect(html).toContain('Everyone with access to the repository can use galley');
  });

  it('shows who would be blocked and each entry with a remove button', () => {
    const html = render(
      <AccessView {...base} entries={[{ id: 'a00000000000001', login: 'bob', createdAt: '2026-10-28T10:00:00Z' }]} people={[person('ana'), person('bob', { githubId: 9 })]} />,
    );
    expect(html).toContain('Blocked now: ana');
    expect(html).toContain('Remove bob');
  });

  it('shows a validation error', () => {
    const html = render(<AccessView {...base} entries={[]} people={[]} error="login" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('GitHub login');
  });
});

describe('Shared drafts', () => {
  it('lists grants with owner, path and time left', () => {
    const html = render(<SharedDraftsView shares={[share()]} now={NOW} onView={noop} />);
    expect(html).toContain('ana');
    expect(html).toContain('chapters/intro.qmd');
    expect(html).toContain('22 h');
    expect(html).toContain('>View</button>');
  });

  it('teaches when nothing is shared', () => {
    expect(render(<SharedDraftsView shares={[]} now={NOW} onView={noop} />)).toContain('Nobody is sharing a draft');
  });

  const draft: SharedDraftContent = { share: share(), path: 'chapters/intro.qmd', content: `Text ${evil}`, size: 12, updatedAt: '2026-10-28T11:00:00Z' };

  it('shows the draft read-only as plain text, with the logging banner', () => {
    const html = render(<SharedDraftViewer draft={draft} onClose={noop} onCopy={noop} />);
    expect(html).toMatch(/Shared by ana until .+ · this view is logged/);
    expect(html).toContain('<pre');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('contenteditable');
    expect(html).toContain('Copy into my own draft');
  });

  it('says the same in Spanish', () => {
    const html = render(
      <I18n.Provider value={es}>
        <SharedDraftViewer draft={draft} onClose={noop} onCopy={noop} />
      </I18n.Provider>,
    );
    expect(html).toContain('Compartido por ana hasta');
    expect(html).toContain('esta vista queda registrada');
  });
});

describe('Activity log', () => {
  const entries: AuditEntry[] = [
    { id: '1', actor: { userId: 'u', login: 'fran' }, action: 'allowlist.add', target: 'allow:1', at: '2026-10-28T10:00:00Z' },
    { id: '2', actor: { userId: 'u', login: 'ana' }, action: 'audit.view', target: 'repo', at: '2026-10-28T09:00:00Z' },
  ];

  it('shows who, what, target and when, filtered by action', () => {
    const html = render(<ActivityView entries={entries} action="allowlist.add" onAction={noop} />);
    expect(html).toContain('<select');
    expect(html).toContain('allow:1');
    expect(html).not.toContain('>repo<');
  });
});

describe('owner share toggle', () => {
  const gateway = (over: Partial<DraftSharesGateway> = {}): DraftSharesGateway => ({
    list: vi.fn(() => Promise.resolve([])),
    share: vi.fn(() => Promise.resolve(share({ owner: { userId: 'u' } }))),
    unshare: vi.fn(() => Promise.resolve()),
    hasDraft: vi.fn(() => Promise.resolve(true)),
    ...over,
  });

  it('shares when off and stops when on', async () => {
    const gw = gateway();
    expect(await toggleShare(gw, 42, 'chapters/intro.qmd', { kind: 'off' })).toEqual({ status: { kind: 'on', expiresAt: '2026-10-29T10:00:00Z' }, notice: 'shared' });
    expect(await toggleShare(gw, 42, 'chapters/intro.qmd', { kind: 'on', expiresAt: 'x' })).toEqual({ status: { kind: 'off' }, notice: 'stopped' });
    expect(gw.share).toHaveBeenCalledWith(42, 'chapters/intro.qmd');
    expect(gw.unshare).toHaveBeenCalledWith(42, 'chapters/intro.qmd');
  });

  it('explains instead of calling when there is no server draft, or the draft is gone', async () => {
    const gw = gateway({ share: vi.fn(() => Promise.reject(new NotFoundError('404'))) });
    expect(await toggleShare(gw, 42, 'a.qmd', { kind: 'no-draft' })).toEqual({ status: { kind: 'no-draft' }, notice: 'no-draft' });
    expect(await toggleShare(gw, 42, 'a.qmd', { kind: 'off' })).toEqual({ status: { kind: 'no-draft' }, notice: 'no-draft' });
    expect(await toggleShare(gateway({ share: vi.fn(() => Promise.reject(new PermissionError('403'))) }), 42, 'a.qmd', { kind: 'off' })).toEqual({
      status: { kind: 'off' },
      notice: 'forbidden',
    });
  });

  it('labels the menu item with the status', () => {
    expect(shareMenuItem({ kind: 'off' }, en, NOW)?.label).toBe('Share this draft with admins (24 h)');
    expect(shareMenuItem({ kind: 'no-draft' }, en, NOW)?.label).toBe('Share this draft with admins (24 h)');
    expect(shareMenuItem({ kind: 'on', expiresAt: '2026-10-29T10:00:00Z' }, en, NOW)?.label).toBe('Stop sharing with admins (22 h left)');
    expect(shareMenuItem({ kind: 'unavailable' }, en, NOW)).toBeUndefined();
    expect(shareMenuItem({ kind: 'on', expiresAt: '2026-10-29T10:00:00Z' }, es, NOW)?.label).toBe('Dejar de compartir con los admins (quedan 22 h)');
  });
});

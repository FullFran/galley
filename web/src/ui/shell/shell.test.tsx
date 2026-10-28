import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { createRef } from 'preact';
import { initialSidebar } from '../../shell/sidebar';
import { AboutDialog } from './AboutDialog';
import { AdminArea } from './AdminArea';
import { AppShell, type ShellContext } from './AppShell';
import { Credit } from './Credit';
import { SaveControl } from './SaveControl';
import { RepoList } from '../RepoList';
import { SignedOut } from '../SignedOut';
import { ProposalList } from '../review/ProposalList';

const noop = () => undefined;

const shell: ShellContext = {
  repo: { id: 1, owner: 'o', name: 'paper', fullName: 'o/paper', defaultBranch: 'main', private: true },
  admin: false,
  user: { login: 'ana', id: 1 },
  proposals: { count: 2, mine: 1 },
  sidebar: { state: initialSidebar(1280), dispatch: noop, toggleRef: createRef(), panelRef: createRef() },
  onNavigate: noop,
  onRepos: noop,
  onSignOut: noop,
};

describe('Credit', () => {
  it('links to the author and the source with safe rel values', () => {
    const html = render(<Credit />);
    expect(html).toContain('Built by');
    expect(html).toContain('FullFran');
    expect(html).toContain('href="https://www.fullfran.com"');
    expect(html).toContain('href="https://github.com/FullFran/galley"');
    expect(html.match(/rel="noopener noreferrer"/g)?.length).toBe(html.match(/<a /g)?.length);
  });
});

describe('AboutDialog', () => {
  it('shows the version, the licence and the credits', () => {
    const html = render(<AboutDialog open={false} onClose={noop} />);
    expect(html).toContain('<dialog');
    expect(html).toMatch(/Version \d+\.\d+\.\d+/);
    expect(html).toContain('MIT');
    expect(html).toContain('CMU Serif');
    expect(html).toContain('Elsevier Harvard');
    expect(html).toContain('href="https://www.fullfran.com"');
  });
});

describe('SignedOut landing', () => {
  const html = render(<SignedOut loginFailed={false} onSignIn={noop} />);

  it('states what galley does in plain words and offers one sign in', () => {
    expect(html).toContain('Write your paper in the browser.');
    expect(html).toContain('reviewable proposal on GitHub');
    expect(html.match(/Sign in with GitHub/g)?.length).toBe(1);
    expect(html).toContain('Built by');
  });

  it('avoids git jargon and old wording', () => {
    for (const word of ['pull request', 'branch', 'commit', 'Edit the files of your paper']) {
      expect(html.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('marks the illustration as decorative', () => {
    expect(html).toMatch(/class="landing-mock"[^>]*aria-hidden="true"/);
  });
});

describe('AppShell', () => {
  const html = render(
    <AppShell shell={shell} active="contents" crumbs={[{ label: 'o/paper', onSelect: noop }, 'sections', 'index.qmd']}>
      <p>content</p>
    </AppShell>,
  );
  const adminHtml = render(
    <AppShell shell={{ ...shell, admin: true }} active="contents" crumbs={[]}>
      x
    </AppShell>,
  );
  /** The popover of one menu, by id, up to the next menu root. */
  const menu = (page: string, id: string) => {
    const start = page.indexOf(`id="${id}"`);
    const end = page.indexOf('class="menu-root"', start);
    return page.slice(start, end === -1 ? undefined : end);
  };

  it('starts with a skip link to the main region', () => {
    expect(html.indexOf('class="skip-link"')).toBeLessThan(html.indexOf('<button'));
    expect(html).toContain('href="#main"');
    expect(html).toMatch(/<main[^>]*id="main"[^>]*tabindex="-1"/);
  });

  it('has nav, aside, header and main landmarks with tour anchors', () => {
    expect(html).toMatch(/<aside[^>]*data-tour="sidebar"/);
    expect(html).toMatch(/<nav[^>]*aria-label="Main"/);
    expect(html).toContain('<header');
    expect(html).toContain('data-tour="proposals"');
    expect(html).toContain('data-tour="help"');
  });

  it('marks the active entry with aria-current, not colour alone', () => {
    expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*?Contents/);
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
  });

  it('starts with the repository switcher row', () => {
    expect(html).toContain('aria-label="Switch repository: o/paper"');
    expect(html.indexOf('repo-switch')).toBeLessThan(html.indexOf('aria-label="Main"'));
  });

  it('groups entries by task, with a collapsible Review header closed by default', () => {
    expect(html).toContain('>Write<');
    expect(html).toMatch(/class="nav-group-head"[^>]*aria-expanded="false"[^>]*aria-controls="nav-group-review"/);
    expect(html).toMatch(/id="nav-group-review"[^>]*hidden/);
  });

  it('opens the Review group when the active route is inside it', () => {
    const page = render(
      <AppShell shell={shell} active="proposals" crumbs={[]}>
        x
      </AppShell>,
    );
    expect(page).toMatch(/aria-expanded="true"[^>]*aria-controls="nav-group-review"/);
  });

  it('shows Chat in the Review group with an unread badge and label', () => {
    const page = render(
      <AppShell shell={{ ...shell, chat: { unread: 3 } }} active="proposals" crumbs={[]}>
        x
      </AppShell>,
    );
    expect(page).toMatch(/aria-label="Chat, 3 unread"/);
    expect(page).toMatch(/<span class="nav-label">Chat<\/span><span class="nav-meta nav-badge" aria-hidden="true">3<\/span>/);
    const none = render(
      <AppShell shell={{ ...shell, chat: { unread: 0 } }} active="proposals" crumbs={[]}>
        x
      </AppShell>,
    );
    expect(none).toMatch(/aria-label="Chat"/);
    expect(none).not.toContain('nav-badge');
  });

  it('never collapses groups in the icon rail', () => {
    const rail = render(
      <AppShell shell={{ ...shell, sidebar: { ...shell.sidebar, state: initialSidebar(900) } }} active="contents" crumbs={[]}>
        x
      </AppShell>,
    );
    expect(rail).not.toContain('nav-group-head');
    expect(rail).not.toMatch(/id="nav-group-review"[^>]*hidden/);
  });

  it('labels icon buttons and shows proposals on one row', () => {
    expect(html).toMatch(/aria-label="(Collapse|Expand) the sidebar"/);
    expect(html).toContain('aria-label="Proposals, 2 open"');
    expect(html).toContain('2 · 1 yours');
    expect(html).not.toContain('Yours: #');
  });

  it('makes breadcrumb segments actionable', () => {
    expect(html).toMatch(/aria-label="Breadcrumb"/);
    expect(html).toMatch(/<button[^>]*class="crumb"[^>]*>o\/paper<\/button>/);
    expect(html).toMatch(/aria-current="location">index.qmd/);
  });

  it('has an account menu with Sign out last, and no one-click sign out', () => {
    expect(html).toContain('aria-label="Account: ana"');
    expect(html).toMatch(/aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="account-menu"/);
    const account = menu(html, 'account-menu');
    const order = [
      'Signed in as ana',
      'Theme',
      'System',
      'Light',
      'Dark',
      'Language',
      'English',
      'Español',
      'Preferences…',
      'Keyboard shortcuts',
      'Take the tour',
      'About galley',
      'Sign out',
    ];
    const positions = order.map((label) => account.indexOf(label));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(account).toMatch(/role="separator"><\/div><button[^>]*role="menuitem"[^>]*><span class="menu-label">Sign out/);
    expect(account).toMatch(/lang="es"[^>]*>Español/);
    expect(account).toMatch(/lang="en"[^>]*>English/);
    expect(html.match(/Sign out/g)?.length).toBe(1);
  });

  it('gives admins and co-authors the same account menu (admin tools live in the Admin area)', () => {
    expect(menu(adminHtml, 'account-menu')).toBe(menu(html, 'account-menu'));
    expect(menu(html, 'account-menu')).not.toMatch(/Admin|Project settings|co-author/);
  });

  it('shows the Admin entry to admins only, and nothing admin-related to co-authors', () => {
    for (const word of ['Admin', 'Project settings', 'View as co-author']) expect(html).not.toContain(word);
    expect(adminHtml).toContain('aria-label="Admin"');
    expect(adminHtml).not.toContain('Project settings');
  });

  it('offers a More menu with Keyboard shortcuts, and a muted credit line', () => {
    expect(menu(html, 'more-menu')).toContain('Keyboard shortcuts');
    expect(html).toContain('galley · by FullFran');
  });

  it('has no inline style attributes', () => {
    expect(html).not.toContain('style=');
    expect(adminHtml).not.toContain('style=');
  });
});

describe('AdminArea', () => {
  const props = {
    tab: 'settings' as const,
    onTab: noop,
    settings: <p>SETTINGS</p>,
    coauthorView: false,
    onCoauthorView: noop,
    coauthorCount: 3,
  };

  it('shows the admin tabs and the settings to admins', () => {
    const html = render(<AdminArea {...props} admin />);
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Project settings/);
    expect(html).toContain('View as co-author');
    expect(html).toContain('SETTINGS');
    for (const tab of ['People', 'Access', 'Shared drafts', 'Activity log']) expect(html).toContain(`>${tab}</button>`);
  });

  it('shows the admin panel on its tabs', () => {
    const html = render(<AdminArea {...props} admin tab="people" panel={<p>PANEL</p>} />);
    expect(html).toContain('PANEL');
    expect(html).not.toContain('SETTINGS');
  });

  it('shows the view-as switch on its tab', () => {
    const html = render(<AdminArea {...props} admin tab="view-as" />);
    expect(html).toMatch(/role="switch"/);
    expect(html).toContain('Co-authors see 3 files.');
  });

  it('never renders admin content for co-authors', () => {
    const html = render(<AdminArea {...props} admin={false} />);
    expect(html).not.toContain('SETTINGS');
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('People');
    expect(html).toContain('Only admins');
  });
});

describe('RepoList', () => {
  const repo = (id: number, name: string, extra = {}) => ({
    id,
    owner: 'o',
    name,
    fullName: `o/${name}`,
    defaultBranch: 'main',
    private: id % 2 === 0,
    ...extra,
  });

  it('shows name, visibility and last update in each row', () => {
    const html = render(<RepoList repos={[repo(2, 'paper', { updatedAt: '2026-10-20T10:00:00Z' })]} onOpen={noop} />);
    expect(html).toContain('o/paper');
    expect(html).toContain('Private');
    expect(html).toContain('Updated');
  });

  it('offers search only for more than five repositories', () => {
    const five = [1, 2, 3, 4, 5].map((n) => repo(n, `p${n}`));
    expect(render(<RepoList repos={five} onOpen={noop} />)).not.toContain('type="search"');
    expect(render(<RepoList repos={[...five, repo(6, 'p6')]} onOpen={noop} />)).toContain('type="search"');
  });
});

describe('ProposalList', () => {
  it('teaches what proposals are when there are none, with one action', () => {
    const html = render(<ProposalList rows={[]} onOpen={noop} onEmptyAction={noop} />);
    expect(html).toContain('No open proposals');
    expect(html.match(/<button/g)?.length).toBe(1);
  });

  it('shows review state as a chip', () => {
    const html = render(
      <ProposalList
        rows={[{ summary: { number: 1, title: 't', updatedAt: '', draft: false }, overall: 'approved', merge: { mergeable: true, state: 'clean' } }]}
        onOpen={noop}
      />,
    );
    expect(html).toMatch(/class="chip chip-ok"[^>]*>Approved/);
  });
});

describe('SaveControl draft state', () => {
  const props = { message: '', placeholder: '', saving: false, onMessage: noop, onSave: noop };
  it('says the unsaved files are kept as a draft', () => {
    const html = render(<SaveControl {...props} dirtyCount={2} draftSaved />);
    expect(html).toContain('Draft saved · 2 unsaved');
    expect(html).toContain('Draft saved · 2 unsaved files');
  });
  it('shows the plain state without a draft or without edits', () => {
    expect(render(<SaveControl {...props} dirtyCount={2} />)).not.toContain('Draft saved');
    expect(render(<SaveControl {...props} dirtyCount={0} draftSaved />)).not.toContain('Draft saved');
  });
});

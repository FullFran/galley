import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { createRef } from 'preact';
import { initialSidebar } from '../../shell/sidebar';
import { AboutDialog } from './AboutDialog';
import { AppShell, type ShellContext } from './AppShell';
import { Credit } from './Credit';
import { RepoList } from '../RepoList';
import { SignedOut } from '../SignedOut';
import { ProposalList } from '../review/ProposalList';

const noop = () => undefined;

const shell: ShellContext = {
  repo: { id: 1, owner: 'o', name: 'paper', fullName: 'o/paper', defaultBranch: 'main', private: true },
  admin: false,
  user: { login: 'ana', id: 1 },
  proposals: { count: 2, mine: 4 },
  sidebar: { state: initialSidebar(1280), dispatch: noop, toggleRef: createRef(), panelRef: createRef() },
  onNavigate: noop,
  onSignOut: noop,
};

describe('Credit', () => {
  it('links to the author and the source with safe rel values', () => {
    const html = render(<Credit />);
    expect(html).toContain('Built by');
    expect(html).toContain('Francisco Olmedo');
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
    <AppShell shell={shell} active="paper" crumbs={['o/paper', 'index.qmd']}>
      <p>content</p>
    </AppShell>,
  );

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
  });

  it('marks the active entry with aria-current, not colour alone', () => {
    expect(html).toMatch(/aria-current="page"[^>]*>[\s\S]*?Paper/);
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
  });

  it('labels icon buttons and shows the proposal count', () => {
    expect(html).toMatch(/aria-label="(Collapse|Expand) the sidebar"/);
    expect(html).toContain('aria-label="Proposals, 2 open"');
    expect(html).toContain('Yours: #4');
  });

  it('shows the breadcrumb and the account with sign out', () => {
    expect(html).toMatch(/aria-label="Breadcrumb"/);
    expect(html).toContain('index.qmd');
    expect(html).toContain('ana');
    expect(html).toContain('Sign out');
  });

  it('hides project settings from co-authors and shows it to admins', () => {
    expect(html).not.toContain('Project settings');
    const admin = render(
      <AppShell shell={{ ...shell, admin: true }} active="paper" crumbs={[]}>
        x
      </AppShell>,
    );
    expect(admin).toContain('Project settings');
  });

  it('has no inline style attributes', () => {
    expect(html).not.toContain('style=');
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
        rows={[{ summary: { number: 1, title: 't', updatedAt: '', draft: false }, overall: 'approved', merge: 'Ready to merge' }]}
        onOpen={noop}
      />,
    );
    expect(html).toMatch(/class="chip chip-ok"[^>]*>Approved/);
  });
});

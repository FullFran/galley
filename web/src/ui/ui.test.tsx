import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { SignedOut } from './SignedOut';
import { RepoList } from './RepoList';
import { StatusBanner } from './StatusBanner';
import { FileTree } from './FileTree';
import { PreviewFrame } from './PreviewFrame';

const noop = () => undefined;

describe('SignedOut', () => {
  it('offers GitHub sign in without an error by default', () => {
    const html = render(<SignedOut loginFailed={false} onSignIn={noop} />);
    expect(html).toContain('Sign in with GitHub');
    expect(html).not.toContain('role="alert"');
  });

  it('explains a failed sign in', () => {
    const html = render(<SignedOut loginFailed onSignIn={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Sign in did not complete');
  });
});

describe('SignedOut on an http origin', () => {
  it('links to the https address instead of offering sign in', () => {
    const html = render(<SignedOut loginFailed={false} httpsUrl="https://galley.fullfran.com/" onSignIn={noop} />);
    expect(html).toContain('Open galley over https');
    expect(html).toContain('href="https://galley.fullfran.com/"');
    expect(html).not.toContain('could not be reached');
    expect(html).not.toContain('Sign in with GitHub');
  });
});

describe('SignedOut with unsaved edits', () => {
  it('keeps edits visible after the session ended', () => {
    const html = render(
      <SignedOut loginFailed={false} unsaved={[{ path: 'paper.qmd', content: 'draft text' }]} onSignIn={noop} />,
    );
    expect(html).toContain('These changes were not saved');
    expect(html).toContain('draft text');
  });
});

describe('RepoList', () => {
  it('explains that the GitHub App must be installed when there are no repositories', () => {
    const html = render(<RepoList repos={[]} onOpen={noop} />);
    expect(html).toContain('No repositories yet');
    expect(html).toContain('galley GitHub App');
  });

  it('lists repositories by full name', () => {
    const repo = { id: 1, owner: 'o', name: 'paper', fullName: 'o/paper', defaultBranch: 'main', private: true };
    expect(render(<RepoList repos={[repo]} onOpen={noop} />)).toContain('o/paper');
  });
});

describe('StatusBanner', () => {
  it('shows the proposal link after a save', () => {
    const html = render(
      <StatusBanner status={{ kind: 'saved', pullRequestUrl: 'https://github.com/o/p/pull/1' }} onReload={noop} onDismiss={noop} />,
    );
    expect(html).toContain('Saved');
    expect(html).toContain('href="https://github.com/o/p/pull/1"');
    expect(html).toContain('View proposal on GitHub');
    expect(html).toContain('target="_blank"');
  });

  it('opens an in-app proposal route in the same tab', () => {
    const html = render(
      <StatusBanner status={{ kind: 'saved', pullRequestUrl: '#/r/o/p/proposals/2' }} onReload={noop} onDismiss={noop} />,
    );
    expect(html).toContain('href="#/r/o/p/proposals/2"');
    expect(html).toContain('View the proposal');
    expect(html).not.toContain('GitHub');
    expect(html).not.toContain('target=');
  });

  it('says the proposal could not be opened when the link is missing', () => {
    const html = render(<StatusBanner status={{ kind: 'saved' }} onReload={noop} onDismiss={noop} />);
    expect(html).toContain('Saved; could not open the proposal, retry later');
    expect(html).not.toContain('href=');
  });

  it('keeps the user text visible on a conflict', () => {
    const html = render(
      <StatusBanner
        status={{ kind: 'conflict', copies: [{ path: 'paper.qmd', content: 'My <careful> paragraph' }], reloaded: false }}
        onReload={noop}
        onDismiss={noop}
      />,
    );
    expect(html).toContain('Someone else changed');
    expect(html).toContain('paper.qmd');
    expect(html).toContain('My &lt;careful> paragraph');
    expect(html).toContain('Reload');
  });

  it('shows error messages as alerts', () => {
    const html = render(<StatusBanner status={{ kind: 'error', message: 'Try again.' }} onReload={noop} onDismiss={noop} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try again.');
  });
});

describe('FileTree', () => {
  it('marks edited files and disables binary files', () => {
    const html = render(
      <FileTree paths={['paper.qmd', 'fig/plot.png']} openPath="paper.qmd" dirty={new Set(['paper.qmd'])} onOpen={noop} />,
    );
    expect(html).toContain('<details');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('(edited)');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*plot\.png/);
  });
});

describe('PreviewFrame', () => {
  it('isolates the preview in a sandbox without same-origin access', () => {
    const html = render(<PreviewFrame seq={1} html="" assets={[]} diagnostics={[]} />);
    // allow-modals lets the frame call window.print() on itself (Print in the preview toolbar).
    expect(html).toMatch(/<iframe[^>]* sandbox="allow-scripts allow-modals"/);
    expect(html).not.toContain('allow-same-origin');
    expect(html).not.toMatch(/allow-(popups|top-navigation|forms|downloads)/);
    expect(html).toContain('src="/preview.html"');
    expect(html).not.toContain('preview note');
  });

  it('lists render diagnostics unobtrusively', () => {
    const diagnostics = [
      { severity: 'warning' as const, message: 'Image not found: figures/a' },
      { severity: 'info' as const, message: 'Code cells are not run.' },
    ];
    const html = render(<PreviewFrame seq={1} html="" assets={[]} diagnostics={diagnostics} />);
    expect(html).toContain('<details class="preview-notes">');
    expect(html).toContain('2 preview notes (1 to check)');
    expect(html).toContain('Image not found: figures/a');
  });
});

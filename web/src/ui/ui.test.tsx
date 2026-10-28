import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { SignedOut } from './SignedOut';
import { RepoList } from './RepoList';
import { StatusBanner } from './StatusBanner';
import { FileTree } from './FileTree';

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
    expect(html).toMatch(/<button[^>]*disabled[^>]*>plot\.png/);
  });
});

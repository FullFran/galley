import { createRef } from 'preact';
import { render } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { initialSidebar } from '../../shell/sidebar';
import { AppShell, type ShellContext } from './AppShell';

const noop = () => undefined;
const shell: ShellContext = {
  admin: false, user: { id: 1, login: 'ana' },
  sidebar: { state: initialSidebar(1280), dispatch: noop, toggleRef: createRef(), panelRef: createRef() },
  onNavigate: noop, onRepos: noop, onSignOut: noop,
};
describe('tour entry points preserve shell menus', () => {
  it('offers full replay from Help and account, a screen guide, and existing Help actions', () => {
    const html = render(<AppShell shell={shell} crumbs={[]}>Paper</AppShell>);
    expect(html.match(/Take the tour/g)).toHaveLength(2);
    expect(html).toContain('Guide for this screen');
    expect(html).toContain('Keyboard shortcuts');
    expect(html).toContain('About galley');
    expect(html).toContain('Sign out');
    expect(html).not.toContain('next version');
    expect(html).not.toContain('style=');
  });
});

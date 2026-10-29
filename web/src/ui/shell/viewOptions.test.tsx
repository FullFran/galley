import { createRef } from 'preact';
import { render } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import { I18n } from '../../i18n';
import { es } from '../../i18n/es';
import { initialSidebar } from '../../shell/sidebar';
import { AppShell, type ShellContext } from './AppShell';
import { PreferencesDialog } from './PreferencesDialog';
import { ShortcutsDialog } from './ShortcutsDialog';
import { ViewMenu } from './ViewMenu';
import { ViewSwitch } from './ViewSwitch';

const noop = () => undefined;
const shell: ShellContext = {
  admin: false,
  user: { id: 1, login: 'ana' },
  sidebar: { state: initialSidebar(1280), dispatch: noop, toggleRef: createRef(), panelRef: createRef() },
  onNavigate: noop,
  onRepos: noop,
  onSignOut: noop,
};

describe('View menu', () => {
  it('shows a labelled View button with the three layouts, the toggle and focus mode', () => {
    const html = render(<ViewMenu layout="preview" focus={false} onLayout={noop} onFocus={noop} onToggle={noop} />);
    expect(html).toContain('aria-label="View options"');
    expect(html).toMatch(/class="view-button-label">View</);
    for (const label of ['Editor + preview', 'Editor only', 'Preview only']) expect(html).toContain(label);
    expect(html).toMatch(/aria-checked="true"[^>]*>Preview only/);
    expect(html).toContain('Ctrl+Alt+V');
    expect(html).toContain('Focus mode');
  });

  it('offers to exit focus mode while it is on, in Spanish too', () => {
    const html = render(
      <I18n.Provider value={es}>
        <ViewMenu layout="both" focus onLayout={noop} onFocus={noop} onToggle={noop} />
      </I18n.Provider>,
    );
    expect(html).toMatch(/class="view-button-label">Vista</);
    expect(html).toContain('Distribución');
    expect(html).toContain('Salir del modo concentración');
  });
});

describe('Edit | Preview', () => {
  it('presses the pane shown, and neither while both show', () => {
    expect(render(<ViewSwitch view="preview" onView={noop} />)).toMatch(/aria-pressed="true"[^>]*>Preview/);
    expect(render(<ViewSwitch view={undefined} onView={noop} />)).not.toContain('aria-pressed="true"');
  });
});

describe('focus mode in the shell', () => {
  it('marks the shell and takes the sidebar out of reach', () => {
    const on = render(<AppShell shell={shell} crumbs={[]} focus>Paper</AppShell>);
    expect(on).toContain('data-focus="true"');
    expect(on).toMatch(/<aside[^>]*inert/);
    const off = render(<AppShell shell={shell} crumbs={[]}>Paper</AppShell>);
    expect(off).not.toContain('data-focus');
  });
});

describe('view options in Preferences and the shortcuts list', () => {
  it('lists the layout and focus mode in Preferences', () => {
    const html = render(<PreferencesDialog open theme="system" onTheme={noop} onClose={noop} />);
    expect(html).toContain('Layout');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>Editor \+ preview/);
    expect(html).toContain('Focus mode');
  });

  it('lists Ctrl+Alt+V in the shortcuts dialog', () => {
    const html = render(<ShortcutsDialog open onClose={noop} />);
    expect(html).toContain('Switch between text only and preview only');
    expect(html).toMatch(/<kbd>Ctrl<\/kbd>.*<kbd>Alt<\/kbd>.*<kbd>V<\/kbd>/);
  });
});

import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { CompileBar } from '../CompileBar';
import { ConfigForm } from './ConfigForm';
import { SetupBanner } from './SetupBanner';
import { Contents } from '../shell/Contents';
import type { GalleyConfig } from '../../config/schema';

const noop = () => undefined;
const notice = { repoName: 'lab/paper', problems: [], dismissed: false, onSettings: noop, onDismiss: noop };

describe('SetupBanner', () => {
  it('offers admins the setup wizard in one line when the paper is not set up', () => {
    const html = render(<SetupBanner {...notice} admin state="missing" />);
    expect(html).toContain('Not set up for galley');
    expect(html).toContain('>Set up…<');
    expect(html).not.toContain('Why?');
  });

  it('tells co-authors who to ask, and what galley shows meanwhile, behind Why?', () => {
    const html = render(<SetupBanner {...notice} admin={false} state="missing" />);
    expect(html).toContain('Why?');
    expect(html).toContain('not set up for galley yet; ask an admin of lab/paper');
    expect(html).toContain('(.qmd, .md, .bib)');
    expect(html).not.toContain('Set up…');
  });

  it('shows nothing once set up, or after dismissal for this repository', () => {
    expect(render(<SetupBanner {...notice} admin={false} state="valid" />)).toBe('');
    expect(render(<SetupBanner {...notice} admin state="missing" dismissed />)).toBe('');
    expect(render(<SetupBanner {...notice} admin state="missing" />)).toContain('aria-label="Dismiss"');
  });

  it('shows admins the problems of an invalid file as text', () => {
    const problems = [{ severity: 'error' as const, message: '"editable" item 1 (<img src=x onerror=alert(1)>): bad' }];
    const html = render(<SetupBanner {...notice} admin state="invalid" problems={problems} />);
    expect(html).toContain('>Fix…<');
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toContain('<img');
  });
});

describe('Contents', () => {
  const contents = (tab: 'outline' | 'files', filesHint?: string) =>
    render(<Contents tab={tab} onTab={noop} outline={<p>OUTLINE</p>} files={<p>FILES</p>} filesHint={filesHint} />);

  it('shows one tree at a time under an Outline | Files radio group', () => {
    const html = contents('outline');
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>Outline/);
    expect(html).toContain('OUTLINE');
    expect(html).not.toContain('FILES');
    expect(contents('files')).toContain('FILES');
  });

  it('says in the Files tooltip that the restriction is a galley view, not a GitHub permission', () => {
    expect(contents('outline', 'This is a galley view, not a GitHub permission.')).toContain('not a GitHub permission');
  });
});

describe('CompileBar', () => {
  const bar = { compiling: false, stale: false, auto: false, onRecompile: noop, onAuto: noop };

  it('shows a Recompile button with its shortcut', () => {
    const html = render(<CompileBar {...bar} />);
    expect(html).toContain('>Recompile<');
    expect(html).toContain('aria-keyshortcuts="Control+Enter Meta+Enter"');
  });

  it('shows Compiling… while a render runs', () => {
    expect(render(<CompileBar {...bar} compiling />)).toContain('Compiling…');
  });

  it('shows an Out of date badge only when edits are not compiled yet, and the last compile in the tooltip', () => {
    const stale = render(<CompileBar {...bar} stale />);
    expect(stale).toContain('Out of date');
    expect(stale).toContain('Edits not shown yet');
    expect(render(<CompileBar {...bar} />)).not.toContain('Out of date');
    expect(render(<CompileBar {...bar} lastCompiledAt={Date.UTC(2026, 9, 28, 12, 0, 0)} />)).toMatch(/title="[^"]*Compiled at/);
  });

  it('shows auto-compile as a switch', () => {
    expect(render(<CompileBar {...bar} />)).toMatch(/type="checkbox"[^>]*role="switch"/);
  });
});

describe('ConfigForm', () => {
  const draft: GalleyConfig = {
    version: 1,
    title: 'Paper',
    entry: 'index.qmd',
    editable: ['index.qmd', 'sections/*.qmd'],
    uploads: [{ folder: 'figures/', accept: ['png', 'pdf'], maxSizeMb: 10 }],
    labels: { 'sections/a.qmd': 'Introduction' },
    preview: { autoCompile: false },
  };
  const files = ['.galley.yml', 'index.qmd', 'sections/a.qmd', 'sections/b.qmd', 'STATE.md', 'run.py', 'figures/x.png'];
  const props = { files, draft, repoProblems: [], branch: 'galley/ada', saving: false, onChange: noop, onSave: noop, onCancel: noop };

  it('titles the wizard and the settings screen', () => {
    expect(render(<ConfigForm {...props} mode="setup" />)).toContain('Set up galley for this paper');
    expect(render(<ConfigForm {...props} mode="settings" />)).toContain('Project settings');
  });

  it('lists candidate files, marks glob coverage and previews what co-authors see', () => {
    const html = render(<ConfigForm {...props} mode="settings" />);
    expect(html).toContain('(included by sections/*.qmd)');
    expect(html).toContain('STATE.md');
    expect(html).not.toContain('run.py');
    expect(html).toContain('Co-authors will see 4 files'); // 3 editable + figures/x.png in the upload folder
    expect(html).toContain('galley/ada');
    expect(html).toContain('not a GitHub permission');
  });

  it('shows the file it will save and blocks saving an invalid draft', () => {
    const ok = render(<ConfigForm {...props} mode="setup" />);
    expect(ok).toContain('version: 1');
    expect(ok).not.toMatch(/type="submit"[^>]*disabled/);
    const bad = render(<ConfigForm {...props} mode="setup" draft={{ ...draft, editable: ['../secret'] }} />);
    expect(bad).toContain('Error: ');
    expect(bad).toMatch(/type="submit"[^>]*disabled/);
  });
});

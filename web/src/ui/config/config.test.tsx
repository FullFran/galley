import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { CompileBar } from '../CompileBar';
import { ConfigForm } from './ConfigForm';
import { ViewNotice } from './ViewNotice';
import type { GalleyConfig } from '../../config/schema';

const noop = () => undefined;
const notice = { repoName: 'lab/paper', visibleCount: 3, problems: [], onSettings: noop };

describe('ViewNotice', () => {
  it('offers admins the setup wizard when the paper is not set up', () => {
    const html = render(<ViewNotice {...notice} admin state="missing" />);
    expect(html).toContain('Set up galley for this paper');
  });

  it('tells co-authors who to ask, and what galley shows meanwhile', () => {
    const html = render(<ViewNotice {...notice} admin={false} state="missing" />);
    expect(html).toContain('not set up for galley yet; ask an admin of lab/paper');
    expect(html).toContain('(.qmd, .md, .bib)');
    expect(html).not.toContain('Set up galley');
  });

  it('says the restriction is a galley view, not a GitHub permission', () => {
    const html = render(<ViewNotice {...notice} admin={false} state="valid" />);
    expect(html).toContain('not a GitHub permission');
    expect(html).not.toContain('Project settings');
  });

  it('shows admins the problems of an invalid file as text', () => {
    const problems = [{ severity: 'error' as const, message: '"editable" item 1 (<img src=x onerror=alert(1)>): bad' }];
    const html = render(<ViewNotice {...notice} admin state="invalid" problems={problems} />);
    expect(html).toContain('Open project settings');
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toContain('<img');
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

  it('says when edits are not compiled yet, and when it last compiled', () => {
    expect(render(<CompileBar {...bar} stale />)).toContain('Edits not shown yet');
    expect(render(<CompileBar {...bar} lastCompiledAt={Date.UTC(2026, 9, 28, 12, 0, 0)} />)).toContain('Compiled at');
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
    expect(html).toContain('Co-authors will see 3 files');
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

import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { FileTree } from './FileTree';
import { Outline } from './shell/Outline';
import { SaveControl } from './shell/SaveControl';
import { I18n } from '../i18n';
import { es } from '../i18n/es';
import type { OutlineItem } from '../shell/outline';
import { describeChange } from '../structure/summary';
import { en } from '../i18n/en';

const noop = () => undefined;
const labels: Record<string, string> = { 'index.qmd': 'The paper', 'sections/01-intro.qmd': 'Introduction' };
const label = (path: string) => labels[path] ?? path.slice(path.lastIndexOf('/') + 1);
const items: OutlineItem[] = [
  { kind: 'heading', level: 1, title: 'Paper', line: 1 },
  { kind: 'include', path: 'sections/01-intro.qmd', line: 3 },
];

describe('friendly names', () => {
  it('shows labels in the Outline with the path as tooltip', () => {
    const html = render(<Outline main="index.qmd" openPath="index.qmd" items={items} label={label} onOpenFile={noop} onHeading={noop} />);
    expect(html).toContain('The paper');
    expect(html).toContain('title="index.qmd"');
    expect(html).toContain('Introduction');
    expect(html).toContain('title="sections/01-intro.qmd"');
  });

  it('shows labels in Files with the path as tooltip', () => {
    const html = render(<FileTree paths={['sections/01-intro.qmd']} dirty={new Set()} labels={labels} onOpen={noop} />);
    expect(html).toContain('Introduction');
    expect(html).toContain('title="sections/01-intro.qmd"');
  });
});

describe('Outline structure actions', () => {
  it('offers New section after / New subsection in, and a + between rows', () => {
    const html = render(
      <Outline
        main="index.qmd"
        openPath="index.qmd"
        items={items}
        label={label}
        onOpenFile={noop}
        onHeading={noop}
        structure={{ onNewSection: noop, onNewSubsection: noop }}
      />,
    );
    expect(html).toContain('New section after “Introduction”');
    expect(html).toContain('New subsection in “Introduction”');
    expect(html).toContain('New subsection in “Paper”');
    expect(html).toContain('aria-label="New section here"');
    expect(html).toContain('New section…');
  });

  it('offers nothing when the person may not change the structure', () => {
    const html = render(<Outline main="index.qmd" openPath="index.qmd" items={items} label={label} onOpenFile={noop} onHeading={noop} />);
    expect(html).not.toContain('New section');
  });
});

describe('Files uploads', () => {
  it('offers Upload on upload folders, also when the folder has no files yet', () => {
    const html = render(
      <FileTree
        paths={['index.qmd']}
        dirty={new Set()}
        uploads={[{ folder: 'figures/', accept: ['png', 'svg'], maxSizeMb: 5 }]}
        pending={new Set(['figures/new.png'])}
        onUpload={noop}
        onOpen={noop}
      />,
    );
    expect(html).toContain('figures');
    expect(html).toContain('Upload to figures/');
    expect(html).toContain('accept=".png,.svg"');
    expect(html).toContain('new.png');
  });
});

describe('save summary', () => {
  it('lists pending structure changes and uploads, with Remove for uploads', () => {
    const html = render(
      <SaveControl
        dirtyCount={3}
        message=""
        placeholder="p"
        saving={false}
        onMessage={noop}
        onSave={noop}
        pending={[
          { key: 's', text: 'New section “Methods” after “Introduction”' },
          { key: 'u', text: 'Add figure “glow.png”', onRemove: noop },
        ]}
      />,
    );
    expect(html).toContain('New section “Methods” after “Introduction”');
    expect(html).toContain('Add figure “glow.png”');
    expect(html).toContain('aria-label="Remove Add figure “glow.png”"');
  });

  it('describes changes in plain language, in both languages', () => {
    expect(describeChange({ kind: 'section', title: 'Methods', after: 'Introduction' }, en)).toBe('New section “Methods” after “Introduction”');
    expect(describeChange({ kind: 'section', title: 'Methods' }, en)).toBe('New section “Methods” at the start');
    expect(describeChange({ kind: 'subsection', title: 'Data', parent: 'Methods' }, en)).toBe('New subsection “Data” in “Methods”');
    expect(describeChange({ kind: 'upload', name: 'glow.png', replace: false }, en)).toBe('Add figure “glow.png”');
    expect(describeChange({ kind: 'upload', name: 'glow.png', replace: true }, es)).toBe('Reemplazar la figura «glow.png»');
    expect(describeChange({ kind: 'section', title: 'Métodos', after: 'Introducción' }, es)).toBe('Nueva sección «Métodos» después de «Introducción»');
  });

  it('renders in Spanish', () => {
    const html = render(
      <I18n.Provider value={es}>
        <Outline main="index.qmd" openPath="index.qmd" items={items} label={label} onOpenFile={noop} onHeading={noop} structure={{ onNewSection: noop, onNewSubsection: noop }} />
      </I18n.Provider>,
    );
    expect(html).toContain('Nueva sección…');
  });
});

import { describe, expect, it } from 'vitest';
import { memoryProject } from '../render/testProject';
import { suggestConfig } from './wizard';
import { parseConfig, serializeConfig } from './schema';

const raw = import.meta.glob<string>('../render/fixtures/paper/**/*', { query: '?raw', import: 'default', eager: true });
const fixture = Object.fromEntries(Object.entries(raw).map(([path, text]) => [path.replace('../render/fixtures/paper/', ''), text]));

describe('suggestConfig', () => {
  it('prefills from the paper: entry, included sections, bibliography, figures and labels', async () => {
    const config = await suggestConfig(memoryProject(fixture));
    expect(config).toEqual({
      version: 1,
      title: 'A synthetic model of glow curves in LiF:Mg,Ti',
      entry: 'index.qmd',
      editable: ['index.qmd', 'references.bib', 'sections/*.qmd'],
      uploads: [{ folder: 'figures/', accept: ['png', 'jpg', 'jpeg', 'svg', 'pdf'], maxSizeMb: 10 }],
      labels: {
        'sections/01-introduction.qmd': 'Introduction',
        'sections/02-model.qmd': 'Model',
        'sections/A-appendix.qmd': 'Derivations',
      },
      preview: { autoCompile: false },
    });
    expect(parseConfig(serializeConfig(config)).problems).toEqual([]);
  });

  it('takes the entry from _quarto.yml and lists only reachable files', async () => {
    const project = memoryProject({
      '_quarto.yml': 'project:\n  render:\n    - paper.qmd\n',
      'paper.qmd': '# Paper\n{{< include parts/a.qmd >}}\n<!-- {{< include parts/b.qmd >}} -->\n',
      'parts/a.qmd': '## Part A {#sec-a}\n{{< include ../shared/c.qmd >}}\n',
      'parts/b.qmd': '# B\n',
      'shared/c.qmd': 'text without heading\n{{< include ../parts/a.qmd >}}\n',
      'notes.md': 'not included',
    });
    const config = await suggestConfig(project);
    expect(config.entry).toBe('paper.qmd');
    expect(config.editable).toEqual(['paper.qmd', 'parts/a.qmd', 'shared/c.qmd']);
    expect(config.uploads).toEqual([]);
    expect(config.labels).toEqual({ 'parts/a.qmd': 'Part A' });
    expect(config.title).toBeUndefined();
  });

  it('falls back to index.qmd and copes with an empty repository', async () => {
    expect((await suggestConfig(memoryProject({ 'index.qmd': 'Hello' }))).editable).toEqual(['index.qmd']);
    const empty = await suggestConfig(memoryProject({}));
    expect(empty.entry).toBeUndefined();
    expect(empty.editable).toEqual([]);
  });

  it('ignores includes that leave the repository', async () => {
    const config = await suggestConfig(memoryProject({ 'index.qmd': '{{< include ../../etc/passwd >}}\n{{< include /abs.qmd >}}' }));
    expect(config.editable).toEqual(['index.qmd']);
  });
});

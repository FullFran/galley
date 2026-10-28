import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../config/project';
import { parseConfig } from '../config/schema';
import { canChangeStructure } from './permission';
import { planSection, planSubsection, type StructureContext } from './plan';

const ENTRY = `---
title: Paper
---

{{< include sections/01-introduction.qmd >}}

{{< include sections/02-model.qmd >}}
`;

const CONFIG = `version: 1
# Files co-authors edit
editable:
  - index.qmd
  - sections/*.qmd
labels:
  sections/01-introduction.qmd: Introduction
  sections/02-model.qmd: Model
`;

function project(text: string): ProjectConfig {
  const { config, problems } = parseConfig(text);
  if (!config) throw new Error('invalid test config');
  return { kind: 'valid', config, problems };
}

function context(over: Partial<StructureContext> = {}): StructureContext {
  const p = over.project ?? project(CONFIG);
  return {
    entry: 'index.qmd',
    entryText: ENTRY,
    files: new Set(['index.qmd', '.galley.yml', 'sections/01-introduction.qmd', 'sections/02-model.qmd']),
    ids: new Set(['sec-introduction', 'sec-model', 'fig-glow']),
    admin: true,
    project: p,
    configText: CONFIG,
    labelOf: (path) => (p.kind === 'valid' ? p.config.labels[path] : undefined) ?? path,
    ...over,
  };
}

const codes = (plan: { problems: { code: string }[] }) => plan.problems.map((p) => p.code);

describe('planSection', () => {
  it('creates the file, inserts the include at the position and labels it (admin)', () => {
    const plan = planSection({ title: 'Methods', after: 5 }, context());
    expect(plan.problems).toEqual([]);
    expect(plan.proposal).toEqual({ path: 'sections/01a-methods.qmd', id: 'sec-methods' });
    expect(plan.summary).toEqual({ kind: 'section', title: 'Methods', after: 'Introduction' });
    const byPath = Object.fromEntries(plan.changes.map((c) => [c.path, c]));
    expect(Object.keys(byPath).sort()).toEqual(['.galley.yml', 'index.qmd', 'sections/01a-methods.qmd']);
    expect(byPath['sections/01a-methods.qmd']).toEqual({ path: 'sections/01a-methods.qmd', text: '# Methods {#sec-methods}\n\n', created: true });
    expect(byPath['index.qmd']?.text).toContain(
      '{{< include sections/01-introduction.qmd >}}\n\n{{< include sections/01a-methods.qmd >}}\n\n{{< include sections/02-model.qmd >}}',
    );
    const config = byPath['.galley.yml']?.text ?? '';
    expect(config).toContain('# Files co-authors edit');
    expect(parseConfig(config).config?.labels['sections/01a-methods.qmd']).toBe('Methods');
  });

  it('adds the file to editable when no pattern covers it (admin)', () => {
    const narrow = 'version: 1\neditable:\n  - index.qmd\n  - sections/01-introduction.qmd\n';
    const plan = planSection({ title: 'Methods', after: 'start' }, context({ project: project(narrow), configText: narrow }));
    expect(plan.problems).toEqual([]);
    expect(plan.summary).toEqual({ kind: 'section', title: 'Methods' });
    const config = parseConfig(plan.changes.find((c) => c.path === '.galley.yml')?.text ?? '').config;
    expect(config?.editable).toContain(plan.proposal.path);
  });

  it('blocks a co-author when the new file would not be editable, and never touches .galley.yml', () => {
    const narrow = 'version: 1\neditable:\n  - index.qmd\n  - sections/01-introduction.qmd\n';
    const plan = planSection({ title: 'Methods', after: 5 }, context({ admin: false, project: project(narrow), configText: undefined }));
    expect(codes(plan)).toEqual(['not-editable']);
  });

  it('lets a co-author add a section an editable pattern covers, without a label', () => {
    const plan = planSection({ title: 'Methods', after: 7 }, context({ admin: false, configText: undefined }));
    expect(plan.problems).toEqual([]);
    expect(plan.changes.map((c) => c.path).sort()).toEqual(['index.qmd', 'sections/03-methods.qmd']);
    expect(plan.summary).toEqual({ kind: 'section', title: 'Methods', after: 'Model' });
  });

  it('respects structure: admin', () => {
    const restricted = project(`${CONFIG}structure: admin\n`);
    expect(codes(planSection({ title: 'Methods', after: 5 }, context({ admin: false, project: restricted })))).toEqual(['permission']);
    expect(codes(planSection({ title: 'Methods', after: 5 }, context({ admin: true, project: restricted, configText: `${CONFIG}structure: admin\n` })))).toEqual([]);
  });

  it('blocks an empty title, an existing file, a duplicate id and reserved names', () => {
    expect(codes(planSection({ title: '   ', after: 5 }, context()))).toContain('title-empty');
    expect(codes(planSection({ title: 'Methods', after: 5, fileName: '02-model.qmd' }, context()))).toEqual(['file-exists']);
    expect(codes(planSection({ title: 'Model', after: 5 }, context()))).toEqual(['id-duplicate']);
    expect(codes(planSection({ title: 'Methods', after: 5, id: 'fig-glow' }, context()))).toEqual(['id-invalid']);
    expect(codes(planSection({ title: 'Methods', after: 5, fileName: 'index.qmd' }, context()))).toEqual(['file-reserved']);
    expect(codes(planSection({ title: 'Methods', after: 5, fileName: '../x.qmd' }, context()))).toEqual(['file-invalid']);
    expect(codes(planSection({ title: 'A {b}', after: 5 }, context()))).toEqual(['title-chars']);
  });

  it('blocks when the include list cannot be read or the entry is missing', () => {
    expect(codes(planSection({ title: 'Methods', after: 'start' }, context({ entryText: 'See {{< include a.qmd >}} here\n' })))).toEqual([
      'includes-unparseable',
    ]);
    expect(codes(planSection({ title: 'Methods', after: 'start' }, context({ entryText: undefined })))).toEqual(['entry-missing']);
  });

  it('warns about a duplicate label but does not block', () => {
    const plan = planSection({ title: 'Introduction', after: 5, id: 'sec-intro-2', fileName: '01a-intro-2.qmd' }, context());
    expect(plan.problems).toEqual([]);
    expect(plan.warnings.map((w) => w.code)).toEqual(['label-duplicate']);
  });
});

describe('planSubsection', () => {
  it('inserts a heading into the parent file', () => {
    const plan = planSubsection(
      { title: 'Data', parent: { path: 'sections/02-model.qmd' } },
      context({ parentText: '# Model {#sec-model}\n\nText.\n' }),
    );
    expect(plan.problems).toEqual([]);
    expect(plan.changes).toEqual([{ path: 'sections/02-model.qmd', text: '# Model {#sec-model}\n\nText.\n\n## Data {#sec-data}\n' }]);
    expect(plan.summary).toEqual({ kind: 'subsection', title: 'Data', parent: 'Model' });
  });

  it('blocks a duplicate id, a missing parent and a restricted structure', () => {
    expect(codes(planSubsection({ title: 'Glow', parent: { path: 'sections/02-model.qmd' }, id: 'sec-model' }, context({ parentText: '# M\n' })))).toEqual([
      'id-duplicate',
    ]);
    expect(codes(planSubsection({ title: 'Data', parent: { path: 'sections/02-model.qmd' } }, context()))).toEqual(['parent-missing']);
    const restricted = project(`${CONFIG}structure: admin\n`);
    expect(codes(planSubsection({ title: 'Data', parent: { path: 'x.qmd' } }, context({ admin: false, project: restricted, parentText: '# M\n' })))).toEqual([
      'permission',
    ]);
  });
});

describe('canChangeStructure', () => {
  it('defaults to anyone with write access; structure: admin limits it to admins', () => {
    expect(canChangeStructure({ kind: 'missing' }, false)).toBe(true);
    expect(canChangeStructure(project(CONFIG), false)).toBe(true);
    expect(canChangeStructure(project(`${CONFIG}structure: admin\n`), false)).toBe(false);
    expect(canChangeStructure(project(`${CONFIG}structure: admin\n`), true)).toBe(true);
  });
});

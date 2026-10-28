import { describe, expect, it } from 'vitest';
import { insertInclude, insertSubsection, readIncludes } from './includes';

const ENTRY = `---
title: Paper
---

{{< include sections/01-introduction.qmd >}}

{{< include sections/02-model.qmd >}}
`;

describe('readIncludes', () => {
  it('lists the entry includes with their lines and style', () => {
    expect(readIncludes('index.qmd', ENTRY)).toEqual({
      includes: [
        { raw: 'sections/01-introduction.qmd', path: 'sections/01-introduction.qmd', line: 5 },
        { raw: 'sections/02-model.qmd', path: 'sections/02-model.qmd', line: 7 },
      ],
      style: { quote: '', blankLines: true },
    });
  });

  it('ignores includes inside code blocks and reads the quote style', () => {
    const text = '```\n{{< include no.qmd >}}\n```\n{{< include "a.qmd" >}}\n{{< include "b.qmd" >}}\n';
    expect(readIncludes('index.qmd', text)).toEqual({
      includes: [
        { raw: 'a.qmd', path: 'a.qmd', line: 4 },
        { raw: 'b.qmd', path: 'b.qmd', line: 5 },
      ],
      style: { quote: '"', blankLines: false },
    });
  });

  it('refuses an include list it cannot place a new line in', () => {
    expect(readIncludes('index.qmd', 'Text {{< include a.qmd >}} more\n')).toEqual({ error: 'unparseable' });
    expect(readIncludes('index.qmd', '{{< include >}}\n')).toEqual({ error: 'unparseable' });
    expect(readIncludes('index.qmd', '{{< include ../../outside.qmd >}}\n')).toEqual({ error: 'unparseable' });
  });
});

describe('insertInclude', () => {
  const style = { quote: '' as const, blankLines: true };

  it('inserts after the chosen include, keeping blank lines between includes', () => {
    expect(insertInclude(ENTRY, 'sections/01a-methods.qmd', 5, style)).toBe(`---
title: Paper
---

{{< include sections/01-introduction.qmd >}}

{{< include sections/01a-methods.qmd >}}

{{< include sections/02-model.qmd >}}
`);
  });

  it('inserts at the start, before the first include', () => {
    expect(insertInclude(ENTRY, 'sections/00-preface.qmd', 'start', style)).toBe(`---
title: Paper
---

{{< include sections/00-preface.qmd >}}

{{< include sections/01-introduction.qmd >}}

{{< include sections/02-model.qmd >}}
`);
  });

  it('inserts after the last include, and appends when there is none', () => {
    expect(insertInclude(ENTRY, 'sections/03-end.qmd', 7, style).endsWith('{{< include sections/02-model.qmd >}}\n\n{{< include sections/03-end.qmd >}}\n')).toBe(true);
    expect(insertInclude('# Paper\n\nHello', 'sections/_a.qmd', 'start', style)).toBe('# Paper\n\nHello\n\n{{< include sections/_a.qmd >}}\n');
  });

  it('follows a compact, quoted style', () => {
    const text = '{{< include "a.qmd" >}}\n{{< include "b.qmd" >}}\n';
    expect(insertInclude(text, 'c.qmd', 1, { quote: '"', blankLines: false })).toBe(
      '{{< include "a.qmd" >}}\n{{< include "c.qmd" >}}\n{{< include "b.qmd" >}}\n',
    );
  });
});

describe('insertSubsection', () => {
  const SECTION = '# Methods {#sec-methods}\n\nText.\n\n## Old\n\nMore.\n\n# Results\n\nR.\n';

  it('adds a level-2 heading at the end of a level-1 section', () => {
    expect(insertSubsection(SECTION, 'Data', 'sec-data', 1)).toBe(
      '# Methods {#sec-methods}\n\nText.\n\n## Old\n\nMore.\n\n## Data {#sec-data}\n\n# Results\n\nR.\n',
    );
  });

  it('goes one level deeper than its parent heading', () => {
    expect(insertSubsection(SECTION, 'Detail', 'sec-detail', 5)).toBe(
      '# Methods {#sec-methods}\n\nText.\n\n## Old\n\nMore.\n\n### Detail {#sec-detail}\n\n# Results\n\nR.\n',
    );
  });

  it('appends under the first heading of a file when no heading is given', () => {
    expect(insertSubsection('# Model {#sec-model}\n\nBody.', 'Fit', 'sec-fit')).toBe('# Model {#sec-model}\n\nBody.\n\n## Fit {#sec-fit}\n');
  });
});

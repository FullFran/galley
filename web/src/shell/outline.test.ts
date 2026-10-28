import { describe, expect, it } from 'vitest';
import { extractOutline } from './outline';

describe('extractOutline', () => {
  it('lists ATX headings with their level and line', () => {
    const text = '# Introduction\n\nText.\n\n## Model details ##\n';
    expect(extractOutline(text)).toEqual([
      { kind: 'heading', level: 1, title: 'Introduction', line: 1 },
      { kind: 'heading', level: 2, title: 'Model details', line: 5 },
    ]);
  });

  it('reads Quarto ids and drops other attributes', () => {
    const text = '## Band model {#sec-band .unnumbered}\n# Appendix {.appendix}\n';
    expect(extractOutline(text)).toEqual([
      { kind: 'heading', level: 2, title: 'Band model', line: 1, id: 'sec-band' },
      { kind: 'heading', level: 1, title: 'Appendix', line: 2 },
    ]);
  });

  it('skips front matter, code blocks and comments', () => {
    const text = [
      '---',
      'title: "# not a heading"',
      '---',
      '',
      '```python',
      '# a comment in code',
      '```',
      '~~~',
      '# also code',
      '~~~',
      '<!--',
      '# commented out',
      '-->',
      '# Real',
    ].join('\n');
    expect(extractOutline(text)).toEqual([{ kind: 'heading', level: 1, title: 'Real', line: 14 }]);
  });

  it('lists include shortcodes so the main file can lead to its sections', () => {
    const text = '---\ntitle: x\n---\n\n{{< include sections/01-introduction.qmd >}}\n\n{{< include "sections/02 model.qmd" >}}\n';
    expect(extractOutline(text)).toEqual([
      { kind: 'include', path: 'sections/01-introduction.qmd', line: 5 },
      { kind: 'include', path: 'sections/02 model.qmd', line: 7 },
    ]);
  });

  it('ignores lines that only look like headings', () => {
    expect(extractOutline('#hashtag\n####### seven\n    # indented code\n#\n')).toEqual([]);
  });

  it('handles CRLF line endings and very long lines quickly', () => {
    expect(extractOutline('# One\r\n## Two {#sec-two}\r\n')).toEqual([
      { kind: 'heading', level: 1, title: 'One', line: 1 },
      { kind: 'heading', level: 2, title: 'Two', line: 2, id: 'sec-two' },
    ]);
    const long = `# ${'{'.repeat(50_000)}${'x'.repeat(50_000)}`;
    const started = performance.now();
    extractOutline(long);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

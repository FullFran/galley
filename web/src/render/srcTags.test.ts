import { describe, expect, it } from 'vitest';
import { render } from './index';
import { expandIncludesMapped, stripComments } from './source';
import { memoryProject } from './testProject';

const tags = (html: string) => [...html.matchAll(/<(\w+)[^>]* data-src="([^"]+)" data-src-end="(\d+)"/g)].map((m) => `${m[1]} ${m[2]}-${m[3]}`);

describe('source line tags', () => {
  it('tags block elements with the file and line they come from, across includes and comments', async () => {
    const index = [
      '---', // 1
      'title: T', // 2
      '---', // 3
      '', // 4
      '# Intro', // 5
      '', // 6
      'First paragraph', // 7
      'continues here.', // 8
      '', // 9
      '{{< include sections/a.qmd >}}', // 10
      '', // 11
      '- item one', // 12
      '- item two', // 13
    ].join('\n');
    const a = [
      '---', // 1
      'x: 1', // 2
      '---', // 3
      '<!-- a note', // 4
      'over two lines -->', // 5
      '## Methods {#sec-m}', // 6
      '', // 7
      '$$', // 8
      'E = mc^2', // 9
      '$$', // 10
    ].join('\n');
    const { html } = await render(memoryProject({ 'index.qmd': index, 'sections/a.qmd': a }));
    expect(tags(html)).toEqual([
      'h2 index.qmd:5-5',
      'p index.qmd:7-8',
      'h3 sections/a.qmd:6-6',
      'div sections/a.qmd:8-10',
      'ul index.qmd:12-13',
      'li index.qmd:12-12',
      'li index.qmd:13-13',
    ]);
  });

  it('escapes paths in the attribute', async () => {
    const { html } = await render(
      memoryProject({ 'index.qmd': '{{< include "a&b.qmd" >}}', 'a&b.qmd': 'Text' }),
    );
    expect(html).toContain('data-src="a&amp;b.qmd:1"');
  });

  it('keeps the expanded text identical to the unmapped expansion', async () => {
    const project = memoryProject({ 'index.qmd': 'a <!-- x\ny --> b\n{{< include c.qmd >}} tail', 'c.qmd': 'C1\nC2' });
    const mapped = await expandIncludesMapped('a <!-- x\ny --> b\n{{< include c.qmd >}} tail', 'index.qmd', 1, project, []);
    expect(mapped.text).toBe(`${stripComments('a <!-- x\ny --> b\n')}C1\nC2 tail`);
    expect(mapped.origins).toEqual([
      { path: 'index.qmd', line: 1 },
      { path: 'c.qmd', line: 1 },
      { path: 'c.qmd', line: 2 },
    ]);
  });
});

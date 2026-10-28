import { describe, expect, it } from 'vitest';
import type { Diagnostic } from './index';
import { render } from './index';
import { expandIncludes, removeShortcodes, stripComments } from './source';
import { memoryProject } from './testProject';

const SIZE = 400 * 1024;
const timed = async <T,>(f: () => T | Promise<T>) => {
  const start = performance.now();
  const value = await f();
  return { value, ms: performance.now() - start };
};

describe('linear scans on hostile input', () => {
  it('strips comments in linear time and keeps an unclosed comment as text', async () => {
    const hostile = '<!--'.repeat(SIZE / 4);
    const { value, ms } = await timed(() => stripComments(hostile));
    expect(ms).toBeLessThan(200);
    expect(value).toBe(hostile);
    expect(stripComments('a <!-- x --> b <!-- y\nz --> c <!-- open')).toBe('a  b  c <!-- open');
  });

  it('scans shortcodes in linear time', async () => {
    const hostile = '{{<a '.repeat(SIZE / 5);
    const diagnostics: Diagnostic[] = [];
    const { value, ms } = await timed(() => removeShortcodes(hostile, diagnostics));
    expect(ms).toBeLessThan(200);
    expect(value).toBe(hostile);
    const includes = await timed(() => expandIncludes('{{< include x'.repeat(SIZE / 13), 'index.qmd', memoryProject({}), []));
    expect(includes.ms).toBeLessThan(200);
  });

  it('still handles normal and escaped shortcodes', () => {
    const diagnostics: Diagnostic[] = [];
    expect(removeShortcodes('a {{< pagebreak >}} b {{{< video x >}}} c {{< video y >}}.', diagnostics)).toBe(
      'a  b {{< video x >}} c .',
    );
    expect(diagnostics.map((d) => d.message)).toEqual([expect.stringContaining('video')]);
  });

  it('renders the hostile documents quickly', async () => {
    for (const body of ['<!--'.repeat(SIZE / 4), '{{<a '.repeat(SIZE / 5)]) {
      const { value, ms } = await timed(() => render(memoryProject({ 'index.qmd': body })));
      expect(ms).toBeLessThan(3000);
      expect(value).toHaveProperty('html');
    }
  });
});

describe('include limits', () => {
  it('stops an exponential include fan-out', async () => {
    // f0 includes f1 twice, f1 includes f2 twice, ...: 2^14 includes without a cycle.
    const files: Record<string, string> = {};
    for (let i = 0; i < 14; i++) files[`f${i}.qmd`] = `Level ${i}.\n\n{{< include f${i + 1}.qmd >}}\n\n{{< include f${i + 1}.qmd >}}\n`;
    files['f14.qmd'] = 'Leaf.\n';
    const project = memoryProject(files);
    const diagnostics: Diagnostic[] = [];
    const { ms } = await timed(() => expandIncludes('{{< include f0.qmd >}}', 'index.qmd', project, diagnostics));
    expect(ms).toBeLessThan(2000);
    expect(project.reads.length).toBeLessThanOrEqual(500);
    expect(diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/too many includes/i)]);
  });

  it('caps the total expanded length', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024);
    const project = memoryProject({ 'big.qmd': big });
    const diagnostics: Diagnostic[] = [];
    const out = await expandIncludes('{{< include big.qmd >}}\n'.repeat(5), 'index.qmd', project, diagnostics);
    expect(out.length).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(diagnostics.map((d) => d.message)).toEqual([expect.stringMatching(/too long/i)]);
  });
});

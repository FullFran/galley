import { describe, expect, it } from 'vitest';
import { defaultHighlightStyle, type TagStyle } from '@codemirror/language';
import { highlightSpecs, markdownParser } from './editorStyle';

function nodeNames(text: string): string[] {
  const names: string[] = [];
  markdownParser.parse(text).iterate({ enter: (node) => void names.push(node.name) });
  return names;
}

describe('editor highlight style', () => {
  it('renders headings bold without an underline', () => {
    const boldUnderlined = (specs: readonly TagStyle[]) =>
      specs.filter((spec) => spec.fontWeight === 'bold' && spec.textDecoration === 'underline');
    expect(boldUnderlined(defaultHighlightStyle.specs)).toHaveLength(1);
    expect(boldUnderlined(highlightSpecs)).toEqual([]);
    expect(highlightSpecs.filter((spec) => spec.fontWeight === 'bold' && spec.textDecoration === 'none')).toHaveLength(1);
  });

  it('keeps bold text and links styled', () => {
    expect(highlightSpecs.some((spec) => spec.fontWeight === 'bold')).toBe(true);
    expect(highlightSpecs.some((spec) => spec.textDecoration === 'underline')).toBe(true);
  });
});

describe('markdown parser', () => {
  it('parses YAML front matter as YAML, not as a setext heading', () => {
    const names = nodeNames('---\ntitle: Glow curves\nauthor: Fran\n---\n\n# Introduction\n');
    expect(names).not.toContain('SetextHeading2');
    expect(names).toContain('ATXHeading1');
  });

  it('still parses headings without front matter', () => {
    expect(nodeNames('# Methods\n\nText.\n')).toContain('ATXHeading1');
  });
});

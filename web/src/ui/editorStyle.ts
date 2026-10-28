import { HighlightStyle, LanguageSupport, defaultHighlightStyle } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';

/**
 * CodeMirror's default highlight rules, except that headings are bold without
 * an underline. The heading rule is the only default rule that is both bold and
 * underlined; links keep their underline.
 */
// The default colours become CSS custom properties (styles.css), which inherit
// into the editor's shadow root, so highlighting follows the light and dark themes.
const SYNTAX: Record<string, string> = {
  '#708': 'keyword',
  '#219': 'atom',
  '#164': 'number',
  '#a11': 'string',
  '#e40': 'regexp',
  '#00f': 'def',
  '#30a': 'type',
  '#085': 'class',
  '#167': 'prop',
  '#256': 'meta',
  '#00c': 'link',
  '#940': 'comment',
  '#f00': 'invalid',
  '#404740': 'plain',
};

const themed = (color: string | undefined) => {
  const name = color && SYNTAX[color];
  return name ? `var(--syntax-${name}, ${color})` : color;
};

export const highlightSpecs = defaultHighlightStyle.specs.map((spec) => {
  const next = spec.color ? { ...spec, color: themed(spec.color) } : spec;
  return next.fontWeight === 'bold' && next.textDecoration === 'underline' ? { ...next, textDecoration: 'none' } : next;
});

export const highlightStyle = HighlightStyle.define(highlightSpecs);

/**
 * Markdown with a YAML front matter block. Plain markdown reads the closing
 * `---` of the front matter as a setext heading underline, which styles the
 * last front matter line as a heading.
 */
// markdownLanguage instead of markdown(): the latter bundles HTML, CSS and
// JavaScript parsers for embedded HTML, which triples the bundle size.
export const markdownSupport: LanguageSupport = yamlFrontmatter({ content: markdownLanguage });

export const markdownParser = markdownSupport.language.parser;

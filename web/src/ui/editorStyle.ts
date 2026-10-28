import { HighlightStyle, LanguageSupport, defaultHighlightStyle } from '@codemirror/language';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';

/**
 * CodeMirror's default highlight rules, except that headings are bold without
 * an underline. The heading rule is the only default rule that is both bold and
 * underlined; links keep their underline.
 */
export const highlightSpecs = defaultHighlightStyle.specs.map((spec) =>
  spec.fontWeight === 'bold' && spec.textDecoration === 'underline' ? { ...spec, textDecoration: 'none' } : spec,
);

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

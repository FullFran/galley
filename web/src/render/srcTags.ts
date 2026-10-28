import type { MarkdownIt as MarkdownItInstance, Token } from 'markdown-it';
import type { Origin } from './source';

// Source line tags: every block element of the preview carries the file and
// line it starts on (`data-src="path:line"`) and the line it ends on
// (`data-src-end="line"`, same file). The preview uses them to map a
// selection or a double-click back to the source, and the editor's "Show in
// preview" to find the block of a line.


const TAGGED = new Set([
  'paragraph_open',
  'heading_open',
  'blockquote_open',
  'bullet_list_open',
  'ordered_list_open',
  'list_item_open',
  'table_open',
  'fence',
  'code_block',
  'math_block',
  'fenced_div_open',
  'figure',
  'hr',
]);

interface SrcMeta {
  src: string;
  srcEnd: number;
}

/** Records the origin of each block token (`map` lines index `origins`). */
export function tagBlocks(tokens: Token[], origins: readonly Origin[]) {
  for (const t of tokens) {
    if (!TAGGED.has(t.type) || !t.map) continue;
    const start = origins[t.map[0]];
    if (!start || !start.path) continue;
    const endOrigin = origins[Math.max(t.map[0], t.map[1] - 1)];
    const srcEnd = endOrigin && endOrigin.path === start.path && endOrigin.line >= start.line ? endOrigin.line : start.line;
    const meta: SrcMeta = { src: `${start.path}:${start.line}`, srcEnd };
    t.meta = { ...t.meta, ...meta };
  }
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FIRST_TAG = /^(\s*<[a-zA-Z][\w-]*)/;

function inject(html: string, token: Token | undefined): string {
  const meta = token?.meta as Partial<SrcMeta> | null | undefined;
  if (!meta?.src || meta.srcEnd === undefined) return html;
  if (!FIRST_TAG.test(html)) return html;
  // Attribute values are escaped, so the first `>` ends the opening tag.
  let end = html.indexOf('>');
  if (end < 0 || html.slice(0, end).includes(' data-src=')) return html;
  if (html[end - 1] === '/') end--;
  return `${html.slice(0, end)} data-src="${escapeAttr(meta.src)}" data-src-end="${meta.srcEnd}"${html.slice(end)}`;
}

/** Wraps the renderer so tagged tokens put their origin on the element they open. */
export function installSourceTags(md: MarkdownItInstance) {
  const rules = md.renderer.rules;
  for (const type of TAGGED) {
    const rule = rules[type];
    if (!rule) continue;
    rules[type] = (tokens, idx, options, env, slf) => inject(rule(tokens, idx, options, env, slf), tokens[idx]);
  }
  const renderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.renderToken = (tokens, idx, options) => inject(renderToken(tokens, idx, options), tokens[idx]);
}

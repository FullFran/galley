import MarkdownIt from 'markdown-it';
import type { MarkdownIt as MarkdownItInstance, StateBlock, StateCore, StateInline, Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { installSourceTags } from './srcTags';
import katex from 'katex';
import type { Diagnostic } from './index';

// Pandoc/Quarto syntax on top of markdown-it. Raw HTML is off, so any markup
// in the source is escaped; links are restricted to safe schemes; math goes
// through KaTeX with trust disabled. Numbers, citations and image assets are
// computed between parsing and rendering (see index.ts) and read from
// `env.galley` by the render rules below.

export interface Attrs {
  id?: string;
  classes: string[];
  kv: Record<string, string>;
}

export type LabelKind = 'sec' | 'fig' | 'tbl' | 'eq';

export interface Label {
  kind: LabelKind;
  /** The number as printed in references, e.g. "2.1", "Appendix A.1", "A.3". */
  number: string;
}

export interface Crossref {
  prefix: Record<LabelKind, string>;
  /** Caption labels, e.g. "Figure" in "Figure 1: ...". */
  title: { fig: string; tbl: string };
}

export interface RenderContext {
  diagnostics: Diagnostic[];
  labels: Map<string, Label>;
  crossref: Crossref;
  numberSections: boolean;
  /** Bibliography HTML, placed in the `#refs` div. */
  references: string;
  referencesPlaced: boolean;
  /** Asset id for each resolved image path. */
  assets: Map<string, string>;
  /** Shared KaTeX macros, so \newcommand and \gdef carry across equations. */
  macros: Record<string, string>;
}

/** markdown-it's env; the footnote plugin keeps its own state in it too. */
export type Env = Record<PropertyKey, unknown> & { galley: RenderContext };

const CROSSREF_KEY = /^(fig|tbl|eq|sec)-/;
const KEY = /^[A-Za-z0-9_](?:[\w-]|[:.#$%&+?<>~/](?=[\w-]))*/;
const SIZE = /^\d+(?:\.\d+)?(?:%|px|cm|mm|in|em|pt)?$/;
const CALLOUT_TITLES: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  important: 'Important',
  caution: 'Caution',
};

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Parses the inside of a Pandoc attribute block: `#id .class key=value key="v w"`. */
export function parseAttrs(src: string): Attrs {
  const attrs: Attrs = { classes: [], kv: {} };
  const re = /#([\w:.-]+)|\.([\w-]+)|([\w-]+)=(?:"([^"]*)"|'([^']*)'|([^\s"']+))|(-)(?=\s|$)/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) attrs.id ??= m[1];
    else if (m[2]) attrs.classes.push(m[2]);
    else if (m[3]) attrs.kv[m[3]] = m[4] ?? m[5] ?? m[6] ?? '';
    else if (m[7]) attrs.classes.push('unnumbered');
  }
  return attrs;
}

const TRAILING_ATTRS = /\s*\{([^{}]*)\}\s*$/;

/** The token at `idx`; render rules and core rules only ask for indices that exist. */
function tok(tokens: Token[], idx: number): Token {
  const t = tokens[idx];
  if (!t) throw new Error(`no token at ${idx}`);
  return t;
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice((state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0), state.eMarks[line]);
}

// ---------------------------------------------------------------- block rules

const CLOSE_MATH = /^((?:(?!\$\$).)*)\$\$\s*(?:\{([^{}]*)\})?\s*$/;

/** `$$ ... $$ {#eq-x}` on one or several lines, as its own block. */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) return false;
  const first = lineText(state, startLine);
  if (!first.startsWith('$$')) return false;
  const rest = first.slice(2);
  let content: string;
  let attrs: string | undefined;
  let last = startLine;
  const same = rest.trim() ? CLOSE_MATH.exec(rest) : null;
  if (same) {
    content = same[1] ?? '';
    attrs = same[2];
  } else {
    if (rest.includes('$$')) return false;
    const lines = [rest];
    let found = false;
    for (let line = startLine + 1; line < endLine; line++) {
      if (state.isEmpty(line)) return false;
      const text = lineText(state, line);
      const m = CLOSE_MATH.exec(text);
      if (m) {
        lines.push(m[1] ?? '');
        attrs = m[2];
        last = line;
        found = true;
        break;
      }
      if (text.includes('$$')) return false;
      lines.push(text);
    }
    if (!found) return false;
    content = lines.join('\n');
  }
  if (silent) return true;
  const token = state.push('math_block', 'div', 0);
  token.content = content;
  token.meta = { attrs: attrs !== undefined ? parseAttrs(attrs) : undefined };
  token.map = [startLine, last + 1];
  state.line = last + 1;
  return true;
}

const DIV_OPEN = /^(:{3,})\s*(\{[^{}]*\}|[\w-]+)\s*:*\s*$/;
const DIV_CLOSE = /^:{3,}\s*$/;

/** Pandoc fenced divs: `::: {#id .class}` ... `:::`, nested by depth. */
function fencedDiv(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) return false;
  const m = DIV_OPEN.exec(lineText(state, startLine));
  if (!m?.[2]) return false;
  if (silent) return true;
  let depth = 1;
  let fence: string | undefined;
  let next = startLine + 1;
  for (; next < endLine; next++) {
    const text = lineText(state, next);
    const marker = /^(`{3,}|~{3,})/.exec(text)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker) fence = marker;
    else if (DIV_OPEN.test(text)) depth++;
    else if (DIV_CLOSE.test(text) && --depth === 0) break;
  }
  const spec = m[2];
  const attrs = parseAttrs(spec.startsWith('{') ? spec.slice(1, -1) : `.${spec}`);
  const open = state.push('fenced_div_open', 'div', 1);
  open.meta = { attrs };
  open.map = [startLine, next];
  const oldMax = state.lineMax;
  state.lineMax = next;
  state.md.block.tokenize(state, startLine + 1, next);
  state.lineMax = oldMax;
  state.push('fenced_div_close', 'div', -1);
  state.line = Math.min(next + 1, endLine);
  return true;
}

// --------------------------------------------------------------- inline rules

function isEscaped(src: string, pos: number): boolean {
  let n = 0;
  for (let i = pos - 1; i >= 0 && src[i] === '\\'; i--) n++;
  return n % 2 === 1;
}

/** `$x$` and `$$x$$`, with Pandoc's rules for where inline math may start and end. */
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src[start] !== '$') return false;
  const display = src[start + 1] === '$';
  const open = display ? 2 : 1;
  let end = start + open;
  for (;;) {
    end = src.indexOf(display ? '$$' : '$', end);
    if (end < 0) return false;
    if (!isEscaped(src, end)) break;
    end++;
  }
  const content = src.slice(start + open, end);
  if (!content.trim()) return false;
  if (!display) {
    if (/\s/.test(content[0] ?? '') || /\s/.test(content[content.length - 1] ?? '')) return false;
    if (/\d/.test(src[end + 1] ?? '')) return false;
  }
  let after = end + open;
  let attrs: Attrs | undefined;
  if (display) {
    const m = /^\s*\{([^{}]*)\}/.exec(src.slice(after));
    if (m && /#eq-/.test(m[1] ?? '')) {
      attrs = parseAttrs(m[1] ?? '');
      after += m[0].length;
    }
  }
  if (!silent) {
    const token = state.push(display ? 'math_display' : 'math_inline', 'span', 0);
    token.content = content;
    token.meta = { attrs };
  }
  state.pos = after;
  return true;
}

interface CiteToken {
  key: string;
  prefix: string;
  suffix: string;
  suppressAuthor: boolean;
}

/** `[see @a, p. 3; -@b]`: a bracketed citation or cross-reference. */
function bracketCitation(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  if (src[state.pos] !== '[') return false;
  const close = src.indexOf(']', state.pos + 1);
  if (close < 0) return false;
  if (src[close + 1] === '(' || src[close + 1] === '[' || src[close + 1] === '{') return false;
  const inner = src.slice(state.pos + 1, close);
  if (!inner.includes('@') || inner.includes('[')) return false;
  const refs: CiteToken[] = [];
  for (const part of inner.split(';')) {
    const m = /^(.*?)(-?)@/.exec(part);
    if (!m || /[\w]$/.test(m[1] ?? '')) return false;
    const rest = part.slice(m[0].length);
    const key = KEY.exec(rest)?.[0];
    if (!key) return false;
    refs.push({ key, prefix: (m[1] ?? '').trimStart(), suffix: rest.slice(key.length).trimEnd(), suppressAuthor: m[2] === '-' });
  }
  if (!silent) {
    const token = state.push('citation', 'span', 0);
    token.meta = { refs, inText: false };
  }
  state.pos = close + 1;
  return true;
}

/** A bare in-text `@key`, not part of a word or an e-mail address. */
function bareCitation(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  if (src[state.pos] !== '@') return false;
  if (state.pos > 0 && /[\w@.+-]/.test(src[state.pos - 1] ?? '')) return false;
  const key = KEY.exec(src.slice(state.pos + 1))?.[0];
  if (!key) return false;
  if (!silent) {
    const token = state.push('citation', 'span', 0);
    token.meta = { refs: [{ key, prefix: '', suffix: '', suppressAuthor: false }], inText: true };
  }
  state.pos += key.length + 1;
  return true;
}

// ----------------------------------------------------------------- core rules

/** `{#id .class}` at the end of a heading; `{.unnumbered}` and `{-}` stop numbering. */
function headingAttrs(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tok(tokens, i);
    if (t.type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    if (!inline) continue;
    const m = TRAILING_ATTRS.exec(inline.content);
    t.meta = { attrs: m ? parseAttrs(m[1] ?? '') : { classes: [], kv: {} } };
    if (m) inline.content = inline.content.slice(0, m.index);
  }
}

/** Moves `: Caption {#tbl-x}` paragraphs next to their pipe table into a <caption>. */
function tableCaptions(state: StateCore) {
  const tokens = state.tokens;
  const isCaption = (i: number) =>
    tokens[i]?.type === 'paragraph_open' &&
    tokens[i + 1]?.type === 'inline' &&
    /^(?:Table)?:\s/.test(tok(tokens, i + 1).content) &&
    tokens[i + 2]?.type === 'paragraph_close';
  for (let i = 0; i < tokens.length; i++) {
    if (tok(tokens, i).type !== 'table_open') continue;
    let close = i;
    while (close < tokens.length && tok(tokens, close).type !== 'table_close') close++;
    let from: number;
    if (isCaption(close + 1)) from = close + 1;
    else if (i >= 3 && isCaption(i - 3)) from = i - 3;
    else continue;
    const [, inline] = tokens.splice(from, 3);
    if (!inline) continue;
    inline.content = inline.content.replace(/^(?:Table)?:\s+/, '');
    const m = TRAILING_ATTRS.exec(inline.content);
    const attrs = m ? parseAttrs(m[1] ?? '') : undefined;
    if (m) inline.content = inline.content.slice(0, m.index);
    const tableAt = from < i ? i - 3 : i;
    const table = tok(tokens, tableAt);
    table.meta = { attrs };
    const open = new state.Token('table_caption_open', 'caption', 1);
    open.meta = { id: attrs?.id };
    const end = new state.Token('table_caption_close', 'caption', -1);
    tokens.splice(tableAt + 1, 0, open, inline, end);
    i = tableAt + 3;
  }
}

/** Image attributes `![..](..){#fig-x width=50%}` and stray span attributes in text. */
function inlineAttrs(state: StateCore) {
  for (const block of state.tokens) {
    const children = block.children;
    if (block.type !== 'inline' || !children) continue;
    for (let i = 0; i < children.length; i++) {
      const t = tok(children, i);
      const next = children[i + 1];
      if ((t.type === 'image' || t.type === 'link_close') && next?.type === 'text') {
        const m = /^\{([^{}]*)\}/.exec(next.content);
        if (m) {
          if (t.type === 'image') t.meta = { attrs: parseAttrs(m[1] ?? '') };
          next.content = next.content.slice(m[0].length);
        }
      }
      if (t.type === 'text') t.content = t.content.replace(/\[([^\]]*)\]\{[^{}]*\}/g, '$1');
    }
  }
}

/** A paragraph that holds only an image becomes a figure. */
function figures(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tok(tokens, i).type !== 'paragraph_open' || tok(tokens, i + 2).type !== 'paragraph_close') continue;
    const children = (tok(tokens, i + 1).children ?? []).filter((c) => !(c.type === 'text' && !c.content.trim()) && c.type !== 'softbreak');
    if (children.length !== 1 || tok(children, 0).type !== 'image') continue;
    const figure = new state.Token('figure', 'figure', 0);
    figure.meta = { image: children[0] };
    figure.map = tok(tokens, i).map;
    tokens.splice(i, 3, figure);
  }
}

/** Marks callout titles and the caption paragraph of `::: {#fig-x}` / `::: {#tbl-x}` divs. */
function divs(state: StateCore) {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tok(tokens, i);
    if (t.type !== 'fenced_div_open') continue;
    const attrs = t.meta?.attrs as Attrs;
    const callout = attrs.classes.find((c) => c.startsWith('callout-'));
    if (callout && tokens[i + 1]?.type === 'heading_open') {
      tok(tokens, i + 1).meta = { ...tok(tokens, i + 1).meta, calloutTitle: true };
    }
    if (attrs.id && /^(fig|tbl)-/.test(attrs.id)) {
      let depth = 0;
      let lastPara = -1;
      for (let j = i + 1; j < tokens.length; j++) {
        const u = tok(tokens, j);
        if (u.type === 'fenced_div_open') depth++;
        if (u.type === 'fenced_div_close') {
          if (depth === 0) break;
          depth--;
        }
        if (depth === 0 && u.type === 'paragraph_open') lastPara = j;
      }
      if (lastPara > 0) tok(tokens, lastPara).meta = { divCaption: attrs.id };
    }
  }
}

// ------------------------------------------------------------------- renderers

function ctxOf(env: unknown): RenderContext {
  return (env as Env).galley;
}

// The preview frame's CSP refuses style attributes parsed from markup, so
// styles are carried in this attribute and applied through the CSSOM there.
export const CSS_ATTR = 'data-galley-css';

function renderMath(content: string, display: boolean, ctx: RenderContext): string {
  try {
    const html = katex.renderToString(content, {
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
      maxSize: 20,
      maxExpand: 1000,
      output: 'htmlAndMathml',
      macros: ctx.macros,
    });
    // KaTeX positions glyphs with inline styles; its attribute values are always escaped and double-quoted.
    return html.replace(/ style="([^"]*)"/g, ` ${CSS_ATTR}="$1"`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.diagnostics.push({ severity: 'warning', message: `Math could not be rendered: ${message}` });
    return `<code class="math-error" title="${escapeHtml(message)}">${escapeHtml(content)}</code>`;
  }
}

function renderEquation(content: string, attrs: Attrs | undefined, ctx: RenderContext, tag: 'div' | 'span'): string {
  const id = attrs?.id;
  const label = id ? ctx.labels.get(id) : undefined;
  const number = label ? `<span class="eq-number">(${escapeHtml(label.number)})</span>` : '';
  const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
  return `<${tag} class="equation"${idAttr}>${renderMath(content, true, ctx)}${number}</${tag}>`;
}

/** Plain text of inline tokens, for alt text; math keeps its TeX source. */
function asText(tokens: Token[] | null): string {
  return (tokens ?? [])
    .map((t) => (t.children ? asText(t.children) : t.type === 'softbreak' ? ' ' : t.content))
    .join('');
}

function renderImage(image: Token, ctx: RenderContext): string {
  const asset = image.meta?.asset as string | undefined;
  const attrs = image.meta?.attrs as Attrs | undefined;
  const alt = escapeHtml(asText(image.children));
  if (!asset) {
    const shown = image.meta?.shownPath as string | undefined;
    return `<span class="missing-image">${shown ? `${escapeHtml(shown)} ` : ''}(image not shown)</span>`;
  }
  const styles: string[] = [];
  for (const dim of ['width', 'height'] as const) {
    const v = attrs?.kv[dim];
    if (v && SIZE.test(v)) styles.push(`${dim}: ${/\d$/.test(v) ? `${v}px` : v}`);
  }
  const style = styles.length ? ` ${CSS_ATTR}="${styles.join('; ')}"` : '';
  void ctx;
  return `<img data-galley-asset="${escapeHtml(asset)}" alt="${alt}"${style}>`;
}

function captionLabel(ctx: RenderContext, id: string | undefined, kind: 'fig' | 'tbl'): string {
  const label = id ? ctx.labels.get(id) : undefined;
  return label ? `<span class="caption-label">${escapeHtml(ctx.crossref.title[kind])} ${escapeHtml(label.number)}:</span> ` : '';
}

function crossrefText(ref: CiteToken, ctx: RenderContext): string {
  const label = ctx.labels.get(ref.key);
  if (!label) {
    ctx.diagnostics.push({ severity: 'warning', message: `Unknown cross-reference @${ref.key}` });
    return `<strong class="unresolved">?@${escapeHtml(ref.key)}</strong>`;
  }
  const n = label.kind === 'eq' && !ref.suppressAuthor ? `(${label.number})` : label.number;
  const text = ref.suppressAuthor ? n : `${ctx.crossref.prefix[label.kind]}\u00a0${n}`;
  const prefix = ref.prefix ? `${escapeHtml(ref.prefix)} ` : '';
  const suffix = ref.suffix ? escapeHtml(ref.suffix) : '';
  return `${prefix}<a class="crossref" href="#${escapeHtml(ref.key)}">${escapeHtml(text)}</a>${suffix}`;
}

function renderCitation(token: Token, ctx: RenderContext): string {
  const refs = token.meta?.refs as CiteToken[];
  const parts: string[] = [];
  const crossrefs = refs.filter((r) => CROSSREF_KEY.test(r.key));
  if (crossrefs.length) parts.push(crossrefs.map((r) => crossrefText(r, ctx)).join(', '));
  if (crossrefs.length < refs.length) {
    const html = token.meta?.html as string | undefined;
    const keys = refs.filter((r) => !CROSSREF_KEY.test(r.key)).map((r) => r.key);
    const missing = (token.meta?.missing as string[] | undefined) ?? [];
    if (html) parts.push(`<span class="citation" data-cites="${escapeHtml(keys.join(' '))}">${html}</span>`);
    for (const key of missing) parts.push(`<strong class="unresolved">?${escapeHtml(key)}</strong>`);
  }
  return parts.join('; ');
}

function installRenderers(md: MarkdownItInstance) {
  const rules = md.renderer.rules;

  rules.math_inline = (tokens, idx, _o, env) => renderMath(tok(tokens, idx).content, false, ctxOf(env));
  rules.math_display = (tokens, idx, _o, env) =>
    renderEquation(tok(tokens, idx).content, tok(tokens, idx).meta?.attrs as Attrs | undefined, ctxOf(env), 'span');
  rules.math_block = (tokens, idx, _o, env) =>
    renderEquation(tok(tokens, idx).content, tok(tokens, idx).meta?.attrs as Attrs | undefined, ctxOf(env), 'div') + '\n';

  rules.citation = (tokens, idx, _o, env) => renderCitation(tok(tokens, idx), ctxOf(env));

  rules.heading_open = (tokens, idx, _o, env) => {
    const t = tok(tokens, idx);
    const attrs = (t.meta?.attrs as Attrs | undefined) ?? { classes: [], kv: {} };
    const id = attrs.id ? ` id="${escapeHtml(attrs.id)}"` : '';
    const number = t.meta?.number as string | undefined;
    const classes = [...(t.meta?.calloutTitle ? ['callout-title'] : []), ...(number ? [] : ['unnumbered'])];
    const cls = classes.length ? ` class="${classes.join(' ')}"` : '';
    const num = number ? `<span class="header-section-number">${escapeHtml(number)}</span> ` : '';
    void env;
    return `<${t.tag}${id}${cls}>${num}`;
  };

  rules.image = (tokens, idx, _o, env) => renderImage(tok(tokens, idx), ctxOf(env));

  rules.figure = (tokens, idx, options, env, slf) => {
    const ctx = ctxOf(env);
    const image = tok(tokens, idx).meta?.image as Token;
    const id = (image.meta?.attrs as Attrs | undefined)?.id;
    const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
    const caption = image.children?.length ? slf.renderInline(image.children, options, env) : '';
    const figcaption = caption ? `<figcaption>${captionLabel(ctx, id, 'fig')}${caption}</figcaption>` : '';
    return `<figure class="figure"${idAttr}>${renderImage(image, ctx)}${figcaption}</figure>\n`;
  };

  rules.table_open = (tokens, idx) => {
    const id = (tok(tokens, idx).meta?.attrs as Attrs | undefined)?.id;
    return `<table${id ? ` id="${escapeHtml(id)}"` : ''}>\n`;
  };
  rules.table_caption_open = (tokens, idx, _o, env) => {
    const id = tok(tokens, idx).meta?.id as string | undefined;
    return `<caption>${captionLabel(ctxOf(env), id, 'tbl')}`;
  };
  rules.table_caption_close = () => '</caption>\n';

  const paragraphOpen = rules.paragraph_open ?? ((tokens, idx, options, _env, slf) => slf.renderToken(tokens, idx, options));
  const paragraphClose = rules.paragraph_close ?? ((tokens, idx, options, _env, slf) => slf.renderToken(tokens, idx, options));
  rules.paragraph_open = (tokens, idx, options, env, slf) => {
    const id = tok(tokens, idx).meta?.divCaption as string | undefined;
    if (!id) return paragraphOpen(tokens, idx, options, env, slf);
    const kind = id.startsWith('tbl-') ? 'tbl' : 'fig';
    return `<figcaption>${captionLabel(ctxOf(env), id, kind)}`;
  };
  rules.paragraph_close = (tokens, idx, options, env, slf) => {
    // The matching open is the nearest preceding paragraph_open at the same level.
    for (let i = idx - 1; i >= 0; i--) {
      const t = tok(tokens, i);
      if (t.type === 'paragraph_open' && t.level === tok(tokens, idx).level) {
        return t.meta?.divCaption ? '</figcaption>\n' : paragraphClose(tokens, idx, options, env, slf);
      }
    }
    return paragraphClose(tokens, idx, options, env, slf);
  };

  rules.fenced_div_open = (tokens, idx, _o, env) => {
    const ctx = ctxOf(env);
    const attrs = tok(tokens, idx).meta?.attrs as Attrs;
    const id = attrs.id;
    if (id === 'refs') {
      ctx.referencesPlaced = true;
      return `<div id="refs" class="references">${ctx.references}`;
    }
    if (id && /^(fig|tbl)-/.test(id)) return `<figure class="figure" id="${escapeHtml(id)}">`;
    const callout = attrs.classes.find((c) => c.startsWith('callout-'));
    const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
    if (callout) {
      const type = callout.slice('callout-'.length);
      const hasHeading = tokens[idx + 1]?.type === 'heading_open';
      const title = attrs.kv.title ?? (hasHeading ? undefined : (CALLOUT_TITLES[type] ?? 'Note'));
      return `<div class="callout ${escapeHtml(callout)}"${idAttr}>${title ? `<div class="callout-title">${escapeHtml(title)}</div>` : ''}`;
    }
    const cls = attrs.classes.length ? ` class="${escapeHtml(attrs.classes.join(' '))}"` : '';
    return `<div${idAttr}${cls}>`;
  };
  rules.fenced_div_close = (tokens, idx) => {
    // Find the matching open to close a <figure> with </figure>.
    let depth = 0;
    for (let i = idx - 1; i >= 0; i--) {
      const t = tok(tokens, i);
      if (t.type === 'fenced_div_close') depth++;
      if (t.type === 'fenced_div_open') {
        if (depth === 0) {
          const id = (t.meta?.attrs as Attrs).id;
          return id && /^(fig|tbl)-/.test(id) ? '</figure>\n' : '</div>\n';
        }
        depth--;
      }
    }
    return '</div>\n';
  };

  const fence = rules.fence;
  if (!fence) throw new Error('markdown-it has no fence renderer');
  rules.fence = (tokens, idx, options, env, slf) => {
    const info = tok(tokens, idx).info.trim();
    if (/^\{=/.test(info)) return '';
    if (/^\{/.test(info)) {
      const lang = escapeHtml(info.replace(/[{}]/g, '').split(/[\s,]/)[0] ?? '');
      return `<pre class="code-cell" data-lang="${lang}"><code>${escapeHtml(tok(tokens, idx).content)}</code></pre>\n`;
    }
    return fence(tokens, idx, options, env, slf);
  };

  rules.footnote_caption = (tokens, idx) => {
    const meta = tok(tokens, idx).meta as { id: number; subId: number };
    return String(meta.id + 1) + (meta.subId > 0 ? `:${meta.subId}` : '');
  };
}

/** Links may only point inside the document or to http(s) and mailto. */
function validateLink(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(trimmed)?.[1];
  return scheme === undefined || scheme === 'http' || scheme === 'https' || scheme === 'mailto';
}

export function createMarkdown(): MarkdownItInstance {
  const md = new MarkdownIt('default', { html: false, linkify: false, typographer: true });
  md.validateLink = validateLink;
  md.use(footnote);
  md.block.ruler.before('fence', 'fenced_div', fencedDiv);
  md.block.ruler.before('paragraph', 'math_block', mathBlock);
  md.inline.ruler.after('escape', 'math', mathInline);
  md.inline.ruler.before('link', 'citation', bracketCitation);
  md.inline.ruler.after('math', 'bare_citation', bareCitation);
  md.core.ruler.after('block', 'heading_attrs', headingAttrs);
  md.core.ruler.after('heading_attrs', 'table_captions', tableCaptions);
  md.core.ruler.after('inline', 'inline_attrs', inlineAttrs);
  md.core.ruler.after('inline_attrs', 'figures', figures);
  md.core.ruler.after('figures', 'divs', divs);
  installRenderers(md);
  installSourceTags(md);
  return md;
}

/** Calls `visit` on every token, descending into inline children and figure images. */
export function walk(tokens: Token[], visit: (t: Token) => void) {
  for (const t of tokens) {
    visit(t);
    if (t.children) walk(t.children, visit);
    if (t.type === 'figure') {
      const image = t.meta?.image as Token;
      visit(image);
      if (image.children) walk(image.children, visit);
    }
  }
}

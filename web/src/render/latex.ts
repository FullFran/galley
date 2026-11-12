import type { Token } from 'markdown-it';
import { collect } from './frontMatter';
import {
  CODE_CELL_NOTE,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  RAW_HTML_NOTE,
  isRecord,
  list,
  loadBibliography,
  prepare,
  str,
  type Diagnostic,
  type Meta,
  type Prepared,
  type ProjectSource,
} from './index';
import { assembleDocument } from './latexTemplate';
import { CALLOUT_TITLES, CROSSREF_KEY, type Attrs, type CiteToken, type RenderContext, walk } from './markdown';
import { resolvePath } from './source';
import { texEscape, texUrl } from './texEscape';

// LaTeX backend: emits the same markdown-it token stream the HTML preview
// renders (so Quarto syntax is parsed in one place only) as an elsarticle, or
// plain article, document that BusyTeX compiles in the browser.

export interface LatexFile {
  /** Path relative to the project root; the compile writes the file there. */
  path: string;
  bytes: Uint8Array;
}

export interface LatexResult {
  /** The main document, `index.tex`. Empty when there is nothing to compile. */
  tex: string;
  /** Project files the compile needs: bibliographies and figures. */
  files: LatexFile[];
  diagnostics: Diagnostic[];
}

/** Compiles a project's entry document to LaTeX. Never throws. */
export async function renderLatex(project: ProjectSource): Promise<LatexResult> {
  const diagnostics: Diagnostic[] = [];
  try {
    return await buildLatex(project, diagnostics);
  } catch (err) {
    diagnostics.push({ severity: 'error', message: `The LaTeX export failed: ${err instanceof Error ? err.message : String(err)}` });
    return { tex: '', files: [], diagnostics };
  }
}

// ------------------------------------------------------------ configuration

const FORMATS = ['pdf', 'elsevier-pdf'];

/** The format names a `format:` value selects: a string, a list or a mapping. */
function formatKeys(format: unknown): string[] {
  if (typeof format === 'string') return [format];
  if (Array.isArray(format)) return format.flatMap(formatKeys);
  return isRecord(format) ? Object.keys(format) : [];
}

function formatSections(format: unknown): Meta[] {
  return isRecord(format) ? FORMATS.map((k) => format[k]).filter(isRecord) : [];
}

/** Project options under the PDF formats, then the front matter; `journal` merges key by key. */
function latexMeta(config: Meta, front: Meta): Meta {
  const sections = [...formatSections(config.format), ...formatSections(front.format)];
  const journal = Object.assign({}, ...[config, ...sections, front].map((m) => (isRecord(m.journal) ? m.journal : {})));
  return { ...config, ...Object.assign({}, ...sections), ...front, journal };
}

const CITE_STYLES: Record<string, { option: string; bst: string }> = {
  number: { option: 'number', bst: 'elsarticle-num' },
  numbername: { option: 'number', bst: 'elsarticle-num-names' },
  authoryear: { option: 'authoryear', bst: 'elsarticle-harv' },
  super: { option: 'super', bst: 'elsarticle-num' },
};
const FORMATTING = ['preprint', 'review', 'doubleblind'];
const MODELS = ['1p', '3p', '5p'];
const LAYOUTS = ['onecolumn', 'twocolumn'];

interface ClassSetup {
  options: string[];
  bibStyle: string;
  numeric: boolean;
  twoColumn: boolean;
  journalName?: string;
}

/** Mirrors elsevier.lua of quarto-journals/elsevier: cite style, formatting, model and layout. */
function elsevierSetup(meta: Meta, diagnostics: Diagnostic[]): ClassSetup {
  const journal = isRecord(meta.journal) ? meta.journal : {};
  const options = list(meta.classoption).map(str).filter((o): o is string => !!o);
  const add = (o: string) => {
    if (!options.includes(o)) options.push(o);
  };
  let style = str(journal['cite-style']) ?? 'number';
  if (!CITE_STYLES[style]) {
    diagnostics.push({ severity: 'warning', message: `Unknown journal cite-style "${style}"; using number. Use one of ${Object.keys(CITE_STYLES).join(', ')}.` });
    style = 'number';
  }
  const cite = CITE_STYLES[style] as { option: string; bst: string };
  add(cite.option);
  const choose = (key: string, allowed: string[]) => {
    const value = str(journal[key]);
    if (value === undefined) return undefined;
    if (allowed.includes(value)) return value;
    diagnostics.push({ severity: 'warning', message: `Unknown journal ${key} "${value}"; use one of ${allowed.join(', ')}.` });
    return undefined;
  };
  const formatting = choose('formatting', FORMATTING);
  if (formatting) add(formatting);
  const model = choose('model', MODELS);
  if (model) add(model);
  const layout = choose('layout', LAYOUTS) ?? (model === '5p' ? 'twocolumn' : undefined);
  if (layout) add(layout);
  return {
    options,
    bibStyle: str(meta['biblio-style']) ?? cite.bst,
    numeric: style !== 'authoryear',
    twoColumn: layout === 'twocolumn',
    journalName: str(journal.name),
  };
}

// ------------------------------------------------------------------- images

const LATEX_IMAGES = ['pdf', 'png', 'jpg', 'jpeg'];
const OTHER_IMAGES = ['svg', 'gif', 'webp', 'eps', 'ps', 'tif', 'tiff', 'bmp'];

interface ImageInfo {
  /** Project path to include, when the figure can be typeset. */
  path?: string;
  /** What the placeholder names. */
  shown: string;
}

interface Resolved {
  infos: Map<Token, ImageInfo>;
  files: LatexFile[];
}

async function resolveImages(token: Token[][], prepared: Prepared, project: ProjectSource): Promise<Resolved> {
  const { entryDir, ctx } = prepared;
  const found: Token[] = [];
  for (const tokens of token) walk(tokens, (t) => t.type === 'image' && found.push(t));
  const present = new Set(project.files);
  const infos = new Map<Token, ImageInfo>();
  const loaded = new Map<string, Promise<Uint8Array | undefined>>();
  let total = 0;

  const read = (path: string) => {
    let p = loaded.get(path);
    if (!p) {
      p = project.readBytes(path).then(
        (bytes) => {
          if (bytes.length > MAX_IMAGE_BYTES || total + bytes.length > MAX_TOTAL_BYTES) {
            ctx.diagnostics.push({ severity: 'warning', path, message: `${path} is too large to include in the draft PDF.` });
            return undefined;
          }
          total += bytes.length;
          return bytes;
        },
        () => {
          ctx.diagnostics.push({ severity: 'warning', path, message: `Could not read the image ${path}` });
          return undefined;
        },
      );
      loaded.set(path, p);
    }
    return p;
  };

  const locate = (src: string): { path?: string; note?: Diagnostic } => {
    let decoded = src;
    try {
      decoded = decodeURI(src);
    } catch {
      /* keep the raw value */
    }
    const base = resolvePath(entryDir, decoded);
    if (base === undefined) return { note: { severity: 'warning', message: `Image not found: ${src}` } };
    const ext = /\.([A-Za-z0-9]+)$/.exec(base)?.[1]?.toLowerCase();
    if (ext && LATEX_IMAGES.includes(ext) && present.has(base)) return { path: base };
    const known = ext !== undefined && (LATEX_IMAGES.includes(ext) || OTHER_IMAGES.includes(ext));
    const stem = known ? base.slice(0, -(ext.length + 1)) : base;
    const sibling = LATEX_IMAGES.map((e) => `${stem}.${e}`).find((p) => present.has(p));
    if (sibling) {
      if (ext && present.has(base)) return { path: sibling, note: { severity: 'info', message: `${src}: LaTeX cannot include .${ext} figures; using ${sibling}.` } };
      return { path: sibling };
    }
    if (ext && OTHER_IMAGES.includes(ext) && present.has(base)) {
      return { note: { severity: 'warning', message: `${src}: pdfLaTeX includes PDF, PNG and JPEG figures only; add a PDF or PNG copy next to it.` } };
    }
    return { note: { severity: 'warning', message: `Image not found: ${src}` } };
  };

  await Promise.all(
    found.map(async (t) => {
      const src = String(t.attrGet('src') ?? '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) {
        ctx.diagnostics.push({ severity: 'info', message: 'Images from outside the repository are not included in the draft PDF.' });
        infos.set(t, { shown: src });
        return;
      }
      const { path, note } = locate(src);
      if (note) ctx.diagnostics.push(note);
      if (!path) {
        infos.set(t, { shown: src });
        return;
      }
      if (!/^[\w./-]+$/.test(path)) {
        ctx.diagnostics.push({ severity: 'warning', path, message: `${path}: spaces and special characters in figure paths can break LaTeX; rename the file.` });
      }
      const bytes = await read(path);
      infos.set(t, bytes ? { path, shown: src } : { shown: src });
    }),
  );

  const files: LatexFile[] = [];
  for (const [path, p] of loaded) {
    const bytes = await p;
    if (bytes) files.push({ path, bytes });
  }
  return { infos, files };
}

// ------------------------------------------------------------------ emitter

const SECTIONS = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'];
const ALIGNED_ENV = /^\s*\\begin\{(?:align|alignat|flalign|gather|multline|eqnarray|equation)\*?\}/;
const BIB_NOTE = 'only BibTeX (.bib) bibliographies can be compiled in the draft PDF.';

type Mode = 'page' | 'float';

interface EmitterOptions {
  prepared: Prepared;
  images: Map<Token, ImageInfo>;
  bibItems: Record<string, unknown>;
  numericCites: boolean;
  twoColumn: boolean;
  bibliography: string;
}

class Emitter {
  readonly unsupported = new Set<string>();
  /** True when a `{#refs}` div took the bibliography. */
  bibPlaced = false;
  private footnotes = new Map<number, Token[]>();
  private warned = new Set<string>();
  private ctx: RenderContext;

  constructor(private o: EmitterOptions) {
    this.ctx = o.prepared.ctx;
  }

  private esc(s: string): string {
    return texEscape(s, this.unsupported);
  }

  private warnOnce(key: string, message: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx.diagnostics.push({ severity: 'warning', message });
  }

  // ----------------------------------------------------------------- blocks

  /** Renders a top-level token list: collects footnote bodies first, then the blocks. */
  document(tokens: Token[]): string {
    const rest: Token[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as Token;
      if (t.type !== 'footnote_block_open') {
        rest.push(t);
        continue;
      }
      const end = this.close(tokens, i);
      let current: { id: number; body: Token[] } | undefined;
      for (const u of tokens.slice(i + 1, end)) {
        if (u.type === 'footnote_open') current = { id: Number(u.meta?.id), body: [] };
        else if (u.type === 'footnote_close' && current) this.footnotes.set(current.id, current.body);
        else current?.body.push(u);
      }
      i = end;
    }
    return this.blocks(rest, 'page');
  }

  /** Index of the token that closes the opener at `from`. */
  private close(tokens: Token[], from: number): number {
    let depth = 0;
    for (let i = from; i < tokens.length; i++) {
      depth += (tokens[i] as Token).nesting;
      if (depth === 0) return i;
    }
    return tokens.length - 1;
  }

  blocks(tokens: Token[], mode: Mode): string {
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as Token;
      const end = t.nesting === 1 ? this.close(tokens, i) : i;
      const inner = tokens.slice(i + 1, end);
      switch (t.type) {
        case 'heading_open':
          out += this.heading(t, tokens[i + 1]);
          break;
        case 'paragraph_open':
          out += this.inline(tokens[i + 1]?.children ?? []) + (t.hidden ? '\n' : '\n\n');
          break;
        case 'bullet_list_open':
        case 'ordered_list_open':
          out += this.listBlock(t, inner);
          break;
        case 'blockquote_open':
          out += `\\begin{quote}\n${this.blocks(inner, mode).trim()}\n\\end{quote}\n\n`;
          break;
        case 'fence':
        case 'code_block':
          out += this.code(t);
          break;
        case 'hr':
          out += '\\begin{center}\\rule{0.5\\linewidth}{0.4pt}\\end{center}\n\n';
          break;
        case 'math_block':
          out += `${this.equation(t)}\n\n`;
          break;
        case 'figure':
          out += this.figure(t.meta?.image as Token, mode);
          break;
        case 'table_open':
          out += this.table(inner, t.meta?.attrs as Attrs | undefined, mode);
          break;
        case 'fenced_div_open':
          out += this.div(t, inner, mode);
          break;
        default:
          break;
      }
      i = end;
    }
    return out;
  }

  private heading(open: Token, inline: Token | undefined): string {
    const level = Math.max(1, Math.min(6, Number(open.tag.slice(1)) - 1));
    const attrs = open.meta?.attrs as Attrs | undefined;
    const star = open.meta?.number === undefined ? '*' : '';
    const label = attrs?.id ? `\\label{${attrs.id}}` : '';
    return `\\${SECTIONS[level - 1]}${star}{${this.inline(inline?.children ?? [])}}${label}\n\n`;
  }

  private listBlock(open: Token, inner: Token[]): string {
    const ordered = open.type === 'ordered_list_open';
    const env = ordered ? 'enumerate' : 'itemize';
    const start = Number(open.attrGet('start') ?? 1);
    let out = `\\begin{${env}}\n`;
    if (ordered && start !== 1) out += `\\setcounter{enumi}{${start - 1}}\n`;
    for (let i = 0; i < inner.length; i++) {
      const t = inner[i] as Token;
      if (t.type !== 'list_item_open') continue;
      const end = this.close(inner, i);
      const text = this.blocks(inner.slice(i + 1, end), 'page').trim();
      out += `\\item ${text.startsWith('[') ? '{}' : ''}${text}\n`;
      i = end;
    }
    return `${out}\\end{${env}}\n\n`;
  }

  private code(t: Token): string {
    const info = t.type === 'fence' ? t.info.trim() : '';
    const raw = /^\{=([\w-]+)\}/.exec(info)?.[1];
    if (raw) return /^(latex|tex)$/.test(raw) ? `${t.content.replace(/\n*$/, '\n')}\n` : '';
    const body = t.content.replace(/\n$/, '').replace(/\\end\{verbatim\}/g, '\\end {verbatim}');
    return `\\begin{verbatim}\n${body}\n\\end{verbatim}\n\n`;
  }

  private equation(t: Token): string {
    const id = (t.meta?.attrs as Attrs | undefined)?.id;
    return this.displayMath(t.content, id);
  }

  private displayMath(content: string, id: string | undefined): string {
    if (ALIGNED_ENV.test(content)) return content.trim();
    if (id) return `\\begin{equation}\\label{${id}}${content}\\end{equation}`;
    return `\\[${content}\\]`;
  }

  private div(open: Token, inner: Token[], mode: Mode): string {
    const attrs = open.meta?.attrs as Attrs;
    const id = attrs.id;
    if (id === 'refs') {
      this.bibPlaced = true;
      return this.o.bibliography ? `\\renewcommand{\\bibsection}{}\n${this.o.bibliography}\n\n` : '';
    }
    if (id && /^(fig|tbl)-/.test(id)) return this.floatDiv(id, inner);
    const callout = attrs.classes.find((c) => c.startsWith('callout-'));
    if (!callout) return this.blocks(inner, mode);
    let title: string;
    let body = inner;
    if (inner[0]?.type === 'heading_open') {
      title = this.inline(inner[1]?.children ?? []);
      body = inner.slice(3);
    } else {
      title = this.esc(attrs.kv.title ?? CALLOUT_TITLES[callout.slice('callout-'.length)] ?? 'Note');
    }
    return `\\begin{quote}\n${title ? `\\textbf{${title}}\\par\n` : ''}${this.blocks(body, mode).trim()}\n\\end{quote}\n\n`;
  }

  /** `::: {#fig-x}` and `::: {#tbl-x}`: the children in one float, the last paragraph as caption. */
  private floatDiv(id: string, inner: Token[]): string {
    let caption = '';
    const rest: Token[] = [];
    for (let i = 0; i < inner.length; i++) {
      const t = inner[i] as Token;
      if (t.type === 'paragraph_open' && t.meta?.divCaption === id) {
        caption = this.inline(inner[i + 1]?.children ?? []);
        i += 2;
      } else rest.push(t);
    }
    const body = this.blocks(rest, 'float').trim();
    const cap = `\\caption{\\label{${id}}${caption}}`;
    if (id.startsWith('tbl-')) return `\\begin{table}\n\\centering\n${cap}\n${body}\n\\end{table}\n\n`;
    return `\\begin{figure}\n\\centering\n${body}\n${cap}\n\\end{figure}\n\n`;
  }

  // ----------------------------------------------------------------- figures

  private size(value: string | undefined, axis: 'width' | 'height'): string | undefined {
    const m = /^(\d+(?:\.\d+)?)(%|px|cm|mm|in|em|pt)?$/.exec(value ?? '');
    if (!m) return undefined;
    const n = Number(m[1]);
    if (m[2] === '%') return `${+(n / 100).toFixed(4)}${axis === 'width' ? '\\linewidth' : '\\textheight'}`;
    return `${n}${m[2] && m[2] !== 'px' ? m[2] : 'bp'}`;
  }

  /** The `\includegraphics` call, or a placeholder box when the figure cannot be typeset. */
  private graphic(image: Token): string {
    const info = this.o.images.get(image);
    if (!info?.path) {
      return `\\fbox{\\parbox{0.8\\linewidth}{\\centering\\small Image not available: \\texttt{${this.esc(info?.shown ?? String(image.attrGet('src') ?? ''))}}}}`;
    }
    const attrs = image.meta?.attrs as Attrs | undefined;
    const width = this.size(attrs?.kv.width, 'width');
    const height = this.size(attrs?.kv.height, 'height');
    if (!width && !height) return `\\pandocbounded{\\includegraphics[keepaspectratio]{${info.path}}}`;
    const opts = width && height ? `width=${width},height=${height}` : width ? `width=${width},height=\\textheight,keepaspectratio` : `height=${height}`;
    return `\\includegraphics[${opts}]{${info.path}}`;
  }

  private figure(image: Token, mode: Mode): string {
    if (mode === 'float') return `${this.graphic(image)}\n\n`;
    const id = (image.meta?.attrs as Attrs | undefined)?.id;
    const caption = this.inline(image.children ?? []);
    if (!id && !caption) return `\\begin{center}\n${this.graphic(image)}\n\\end{center}\n\n`;
    return `\\begin{figure}\n\\centering\n${this.graphic(image)}\n\\caption{${id ? `\\label{${id}}` : ''}${caption}}\n\\end{figure}\n\n`;
  }

  // ------------------------------------------------------------------ tables

  private table(inner: Token[], attrs: Attrs | undefined, mode: Mode): string {
    let caption = '';
    const rows: { head: boolean; cells: { text: string; length: number; align: string }[] }[] = [];
    let head = false;
    let row: (typeof rows)[number] | undefined;
    for (let i = 0; i < inner.length; i++) {
      const t = inner[i] as Token;
      if (t.type === 'table_caption_open') {
        caption = this.inline(inner[i + 1]?.children ?? []);
        i += 2;
      } else if (t.type === 'thead_open') head = true;
      else if (t.type === 'thead_close') head = false;
      else if (t.type === 'tr_open') {
        row = { head, cells: [] };
        rows.push(row);
      } else if (t.type === 'th_open' || t.type === 'td_open') {
        const content = inner[i + 1];
        const align = /text-align:\s*(left|right|center)/.exec(String(t.attrGet('style') ?? ''))?.[1] ?? 'left';
        row?.cells.push({ text: this.inline(content?.children ?? []), length: (content?.content ?? '').length, align });
      }
    }
    const columns = Math.max(0, ...rows.map((r) => r.cells.length));
    if (columns === 0) return '';
    const widths = Array.from({ length: columns }, (_, c) => Math.max(1, ...rows.map((r) => r.cells[c]?.length ?? 0)));
    const sum = widths.reduce((a, b) => a + b, 0);
    const aligns = Array.from({ length: columns }, (_, c) => rows[0]?.cells[c]?.align ?? 'left');
    const wide = sum > 72;
    const spec = wide
      ? `@{}${widths
          .map((w, c) => {
            const a = aligns[c] === 'right' ? '\\raggedleft' : aligns[c] === 'center' ? '\\centering' : '\\raggedright';
            return `>{${a}\\arraybackslash}p{(\\linewidth - ${2 * (columns - 1)}\\tabcolsep) * \\real{${(Math.max(w, 6) / widths.reduce((s, x) => s + Math.max(x, 6), 0)).toFixed(4)}}}`;
          })
          .join('')}@{}`
      : `@{}${aligns.map((a) => (a === 'right' ? 'r' : a === 'center' ? 'c' : 'l')).join('')}@{}`;
    const line = (r: (typeof rows)[number]) => `${r.cells.map((c) => c.text).join(' & ')} \\\\`;
    const headRows = rows.filter((r) => r.head).map(line).join('\n');
    const bodyRows = rows.filter((r) => !r.head).map(line).join('\n');
    const id = attrs?.id;

    if (mode === 'page' && !this.o.twoColumn) {
      const cap = caption || id ? `\\caption{${caption}}${id ? `\\label{${id}}` : ''}\\tabularnewline\n` : '';
      const header = `\\toprule\\noalign{}\n${headRows}\n\\midrule\\noalign{}\n`;
      return `\\begin{longtable}[]{${spec}}\n${cap}${header}${cap ? `\\endfirsthead\n${header}` : ''}\\endhead\n\\bottomrule\\noalign{}\n\\endlastfoot\n${bodyRows}\n\\end{longtable}\n\n`;
    }
    const tabular = `\\begin{tabular}{${spec}}\n\\toprule\n${headRows}\n\\midrule\n${bodyRows}\n\\bottomrule\n\\end{tabular}`;
    if (mode === 'float') return `${tabular}\n\n`;
    return `\\begin{table}\n\\centering\n${caption || id ? `\\caption{${id ? `\\label{${id}}` : ''}${caption}}\n` : ''}${tabular}\n\\end{table}\n\n`;
  }

  // ------------------------------------------------------------------ inline

  inline(tokens: Token[]): string {
    let out = '';
    const stack: { out: string; wrap: (s: string) => string }[] = [];
    const open = (wrap: (s: string) => string) => {
      stack.push({ out, wrap });
      out = '';
    };
    const close = () => {
      const frame = stack.pop();
      if (frame) out = frame.out + frame.wrap(out);
    };
    let strip = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as Token;
      switch (t.type) {
        case 'text':
        case 'text_special':
          out += this.esc(strip ? t.content.slice(strip) : t.content);
          strip = 0;
          break;
        case 'softbreak':
          out += '\n';
          break;
        case 'hardbreak':
          out += '\\\\\n';
          break;
        case 'em_open':
          open((s) => `\\emph{${s}}`);
          break;
        case 'strong_open':
          open((s) => `\\textbf{${s}}`);
          break;
        case 's_open':
          open((s) => s);
          break;
        case 'link_open': {
          const href = String(t.attrGet('href') ?? '');
          open((s) => (href.startsWith('#') ? `\\hyperref[${href.slice(1)}]{${s}}` : `\\href{${texUrl(href)}}{${s}}`));
          break;
        }
        case 'em_close':
        case 'strong_close':
        case 's_close':
        case 'link_close':
          close();
          break;
        case 'code_inline': {
          const raw = /^\{=([\w-]+)\}/.exec(tokens[i + 1]?.type === 'text' ? (tokens[i + 1] as Token).content : '');
          if (raw) {
            if (/^(latex|tex)$/.test(raw[1] ?? '')) out += t.content;
            strip = raw[0].length;
          } else out += `\\texttt{${this.esc(t.content)}}`;
          break;
        }
        case 'math_inline':
          out += `\\(${t.content}\\)`;
          break;
        case 'math_display':
          out += `\n${this.displayMath(t.content, (t.meta?.attrs as Attrs | undefined)?.id)}\n`;
          break;
        case 'image':
          out += this.graphic(t);
          break;
        case 'citation':
          out += this.citation(t);
          break;
        case 'footnote_ref': {
          const body = this.footnotes.get(Number(t.meta?.id));
          out += body ? `\\footnote{${this.blocks(body, 'page').trim()}}` : '';
          break;
        }
        default:
          break;
      }
    }
    while (stack.length) close();
    return out;
  }

  // --------------------------------------------------------------- citations

  private citation(t: Token): string {
    const refs = t.meta?.refs as CiteToken[];
    const crossrefs = refs.filter((r) => CROSSREF_KEY.test(r.key));
    const cites = refs.filter((r) => !CROSSREF_KEY.test(r.key));
    const parts: string[] = [];
    if (crossrefs.length) parts.push(crossrefs.map((r) => this.crossref(r)).join(', '));
    if (cites.length) parts.push(this.cite(cites, t.meta?.inText === true));
    return parts.join('; ');
  }

  private crossref(ref: CiteToken): string {
    const label = this.ctx.labels.get(ref.key);
    if (!label) {
      this.warnOnce(`x:${ref.key}`, `Unknown cross-reference @${ref.key}`);
      return `\\textbf{?@${this.esc(ref.key)}}`;
    }
    const prefix = this.ctx.crossref.prefix[label.kind];
    const link = `\\ref{${ref.key}}`;
    let text: string;
    if (ref.suppressAuthor) text = link;
    else if (label.kind === 'eq') text = `${prefix ? `${this.esc(prefix)}~` : ''}(${link})`;
    else text = `${prefix ? `${this.esc(prefix)}~` : ''}${link}`;
    return `${ref.prefix.trim() ? `${this.esc(ref.prefix.trim())} ` : ''}${text}${ref.suffix ? this.esc(ref.suffix) : ''}`;
  }

  /** natbib's `[pre][post]` optional arguments; the post note loses its leading comma. */
  private notes(ref: CiteToken): { pre: string; post: string } {
    const pre = this.esc(ref.prefix.trim());
    const post = this.esc(ref.suffix.replace(/^\s*,?\s*/, '').trim()).replace(/\b(pp?)\.\s+(?=\d)/g, '$1.~');
    return { pre, post };
  }

  private cite(refs: CiteToken[], inText: boolean): string {
    for (const r of refs) {
      if (!(r.key in this.o.bibItems)) this.warnOnce(`c:${r.key}`, `No bibliography entry for @${r.key}`);
    }
    const keys = refs.map((r) => r.key).join(',');
    const notes = refs.map((r) => this.notes(r));
    const plain = notes.every((n) => !n.pre && !n.post);
    const allYear = refs.every((r) => r.suppressAuthor);
    const noneYear = refs.every((r) => !r.suppressAuthor);
    const opts = (n: { pre: string; post: string }) => (n.pre || n.post ? `[${n.pre}][${n.post}]` : '');
    if (refs.length === 1 || (plain && (allYear || noneYear))) {
      const command = allYear ? 'citeyearpar' : inText && !this.o.numericCites ? 'citet' : 'citep';
      return `\\${command}${opts(notes[0] ?? { pre: '', post: '' })}{${keys}}`;
    }
    const items = refs.map((r, i) => {
      const n = notes[i] ?? { pre: '', post: '' };
      if (!r.suppressAuthor) return `\\citealp${opts(n)}{${r.key}}`;
      return `${n.pre ? `${n.pre} ` : ''}\\citeyear{${r.key}}${n.post ? `, ${n.post}` : ''}`;
    });
    return `\\citetext{${items.join('; ')}}`;
  }
}

// ------------------------------------------------------------------ assembly

const plainText = (tokens: Token[]): string =>
  tokens
    .map((t) => (t.children ? plainText(t.children) : t.type === 'softbreak' ? ' ' : t.type === 'text' || t.type === 'code_inline' || t.type === 'math_inline' ? t.content : ''))
    .join('');

async function buildLatex(project: ProjectSource, diagnostics: Diagnostic[]): Promise<LatexResult> {
  const prepared = await prepare(project, diagnostics, latexMeta);
  if (!prepared) return { tex: '', files: [], diagnostics };
  const { entryDir, config, front, meta, ctx, tokens, abstractTokens, md } = prepared;

  // The HTML-only notes from numbering do not apply to the PDF.
  for (let i = diagnostics.length - 1; i >= 0; i--) {
    const m = diagnostics[i]?.message;
    if (m === RAW_HTML_NOTE || m === CODE_CELL_NOTE) diagnostics.splice(i, 1);
  }
  let cells = false;
  walk(tokens, (t) => {
    if (t.type === 'fence' && /^\{(?!=)/.test(t.info.trim())) cells = true;
  });
  if (cells) diagnostics.push({ severity: 'info', message: 'Code cells are not run; their source is shown in the draft PDF.' });

  const elsevier = [config.format, front.format].some((f) => formatKeys(f).includes('elsevier-pdf'));
  let setup: ClassSetup;
  if (elsevier) setup = elsevierSetup(meta, diagnostics);
  else {
    diagnostics.push({ severity: 'info', message: 'No elsevier-pdf format in _quarto.yml: the draft uses the generic article class, not the journal layout.' });
    setup = { options: list(meta.classoption).map(str).filter((o): o is string => !!o), bibStyle: str(meta['biblio-style']) ?? 'plainnat', numeric: false, twoColumn: false };
  }

  const bib = await loadBibliography(meta, entryDir, project, diagnostics);
  const files: LatexFile[] = [];
  const bibNames: string[] = [];
  for (const path of bib.paths) {
    if (!/\.bib$/i.test(path)) {
      diagnostics.push({ severity: 'warning', path, message: `${path}: ${BIB_NOTE}` });
      continue;
    }
    files.push({ path, bytes: new TextEncoder().encode(await project.readText(path)) });
    bibNames.push(path.replace(/\.bib$/i, ''));
  }
  let cited = false;
  for (const set of [abstractTokens, tokens]) walk(set, (t) => t.type === 'citation' && (t.meta?.refs as CiteToken[]).some((r) => !CROSSREF_KEY.test(r.key)) && (cited = true));
  // `\bibliography{name}` takes the name without ".bib": bibtex8 would look for name.bib.bib otherwise.
  const bibliography = cited && bibNames.length ? `\\bibliography{${bibNames.join(',')}}` : '';

  const resolved = await resolveImages([abstractTokens, tokens], prepared, project);
  const emitter = new Emitter({ prepared, images: resolved.infos, bibItems: bib.items, numericCites: setup.numeric, twoColumn: setup.twoColumn, bibliography });
  const body = emitter.document(tokens).trim();
  const abstract = abstractTokens.length ? emitter.document(abstractTokens).trim() : '';

  const title = str(front.title);
  const subtitle = str(front.subtitle);
  const inlineOf = (s: string) => emitter.inline(md.parseInline(s, { galley: ctx })[0]?.children ?? []);
  const titleTex = title ? `${inlineOf(title)}${subtitle ? ` \\\\\\large{${inlineOf(subtitle)}}` : ''}` : '';
  const { authors, affiliations } = collect(front);
  const keywords = list(front.keywords).map(str).filter((k): k is string => !!k);
  const journal = isRecord(meta.journal) ? meta.journal : {};
  const highlights = list(journal.highlights).map(str).filter((h): h is string => !!h);

  const esc = (s: string) => texEscape(s, emitter.unsupported);
  const frontmatter = elsevier
    ? elsevierFrontmatter()
    : articleFrontmatter();

  function elsevierFrontmatter(): string {
    const out: string[] = ['\\begin{frontmatter}'];
    if (titleTex) out.push(`\\title{${titleTex}}`);
    for (const a of authors) {
      const marks = a.marks.length ? `[${a.marks.map((m) => m + 1).join(',')}]` : '';
      out.push(`\\author${marks}{${esc(a.name)}${a.corresponding ? '\\corref{cor1}' : ''}}`);
      if (a.email) out.push(`\\ead{${esc(a.email)}}`);
    }
    affiliations.forEach((a, i) => {
      const f = a.fields;
      const field = (k: string) => (f ? str(f[k]) : undefined);
      const name = field('name');
      const department = field('department');
      const parts = [`organization={${esc(name ? (department ? `${name}, ${department}` : name) : (department ?? a.text))}}`];
      if (field('address')) parts.push(`addressline={${esc(field('address') ?? '')}}`);
      if (field('city')) parts.push(`city={${esc(field('city') ?? '')}}`);
      if (field('country')) parts.push(`country={${esc(field('country') ?? '')}}`, 'countrysep={,}');
      if (field('postal-code')) parts.push(`postcode={${esc(field('postal-code') ?? '')}}`);
      parts.push('postcodesep={}');
      out.push(`\\affiliation[${i + 1}]{${parts.join(',')}}`);
    });
    out.push('', '\\cortext[cor1]{Corresponding author}', '');
    if (abstract) out.push(`\\begin{abstract}\n${abstract}\n\\end{abstract}`, '');
    if (highlights.length) out.push(`\\begin{highlights}\n${highlights.map((h) => `\\item ${inlineOf(h)}`).join('\n')}\n\\end{highlights}`, '');
    if (keywords.length) out.push(`\\begin{keyword}\n    ${keywords.map(esc).join(' \\sep\n    ')}\n\\end{keyword}`);
    out.push('\\end{frontmatter}', '');
    return out.join('\n');
  }

  function articleFrontmatter(): string {
    const out: string[] = [];
    const many = affiliations.length > 1 || authors.some((a) => a.marks.length > 0);
    if (titleTex) out.push(`\\title{${titleTex}}`);
    if (authors.length) {
      const names = authors.map((a) => `${esc(a.name)}${many && a.marks.length ? `\\textsuperscript{${a.marks.map((m) => m + 1).join(',')}}` : ''}`).join(', ');
      const affs = affiliations.map((a, i) => `${many ? `\\textsuperscript{${i + 1}}` : ''}${esc(a.text)}`);
      out.push(`\\author{${[names, ...affs].join(' \\\\\n')}}`);
    }
    if (titleTex || authors.length) out.push('\\date{}', '\\maketitle', '');
    if (abstract) out.push(`\\begin{abstract}\n${abstract}\n\\end{abstract}`, '');
    if (highlights.length) out.push(`\\textbf{Highlights}\n\\begin{itemize}\n${highlights.map((h) => `\\item ${inlineOf(h)}`).join('\n')}\n\\end{itemize}`, '');
    if (keywords.length) out.push(`\\noindent\\textbf{Keywords:} ${keywords.map(esc).join(', ')}`, '');
    return out.join('\n');
  }

  const tex = assembleDocument({
    elsevier,
    classOptions: setup.options,
    bibStyle: setup.bibStyle,
    journalName: setup.journalName ? esc(setup.journalName) : undefined,
    pdfTitle: esc(plainText(md.parseInline(title ?? '', { galley: ctx })).trim()),
    pdfAuthor: esc(authors.map((a) => a.name).join('; ')),
    pdfKeywords: esc(keywords.join(', ')),
    frontmatter,
    body,
    trailer: bibliography && !emitter.bibPlaced ? bibliography : '',
  });

  for (const cp of emitter.unsupported) {
    diagnostics.push({ severity: 'warning', message: `${cp} cannot be typeset by pdfLaTeX and was replaced by "?".` });
  }
  for (const f of resolved.files) files.push(f);
  return { tex, files, diagnostics };
}

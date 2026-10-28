import { load } from 'js-yaml';
import type { Token } from 'markdown-it';
import { parseBibtex, type CslItem } from './bibtex';
import { formatCitations, type Cluster } from './citations';
import { renderTitleBlock } from './frontMatter';
import { createMarkdown, walk, type Attrs, type Crossref, type Env, type Label, type RenderContext } from './markdown';
import { dirname, expandIncludes, removeShortcodes, resolvePath, splitFrontMatter } from './source';
import { MAX_ASSETS, MAX_HTML_LENGTH } from '../preview/protocol';

// Client-side Quarto preview: turns a project (entry file, includes,
// bibliography, figures) into HTML that looks like the elsarticle preprint.
// This module is the only place that knows Quarto syntax, so it can later be
// swapped for Quarto's own WASM renderer behind the same `render` function.

export interface ProjectSource {
  /** Repository file paths; used to find the entry file and figure extensions. */
  files: readonly string[];
  /** Entry document chosen in `.galley.yml`; used when it is one of `files`. */
  entry?: string;
  /** The current text of a file: the unsaved buffer if there is one, else the repository content. */
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
}

export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
}

export interface PreviewAsset {
  /** Referenced from the HTML as `data-galley-asset="<id>"`. */
  id: string;
  path: string;
  type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml';
  bytes: Uint8Array;
}

export interface RenderResult {
  /**
   * Body HTML for the preview frame. Markup from the source is always escaped.
   * There are no `style` attributes (the frame's CSP refuses them); styles are
   * in `data-galley-css` and images reference assets by `data-galley-asset`.
   */
  html: string;
  assets: PreviewAsset[];
  diagnostics: Diagnostic[];
}

type Meta = Record<string, unknown>;

const IMAGE_TYPES: Record<string, PreviewAsset['type']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

let markdown: ReturnType<typeof createMarkdown> | undefined;
const md = () => (markdown ??= createMarkdown());

function isRecord(v: unknown): v is Meta {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseYaml(text: string, where: string, diagnostics: Diagnostic[]): Meta {
  try {
    const value = load(text);
    return isRecord(value) ? value : {};
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    diagnostics.push({ severity: 'error', path: where, message: `The ${where} front matter is not valid YAML: ${reason}` });
    return {};
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function findEntry(files: readonly string[], config: Meta): string | undefined {
  const project = isRecord(config.project) ? config.project : {};
  const listed = list(project.render)
    .map(str)
    .find((p) => p && /\.(qmd|md)$/.test(p) && !p.includes('*') && files.includes(p));
  if (listed) return listed;
  return ['index.qmd', 'index.md'].find((p) => files.includes(p));
}

function crossrefConfig(meta: Meta): Crossref {
  const c = isRecord(meta.crossref) ? meta.crossref : {};
  const get = (key: string, fallback: string) => str(c[key]) ?? fallback;
  return {
    prefix: {
      fig: get('fig-prefix', 'Figure'),
      tbl: get('tbl-prefix', 'Table'),
      eq: get('eq-prefix', 'Equation'),
      sec: get('sec-prefix', 'Section'),
    },
    title: { fig: get('fig-title', 'Figure'), tbl: get('tbl-title', 'Table') },
  };
}

/**
 * Numbers sections, figures, tables and equations in document order, the way
 * elsarticle does: "1", "1.1"; after a raw LaTeX `\appendix`, "Appendix A",
 * "Appendix A.1", with figures, tables and equations numbered "A.1".
 */
function number(tokens: Token[], ctx: RenderContext) {
  const counters = [0, 0, 0, 0, 0, 0];
  const items = { fig: 0, tbl: 0, eq: 0 };
  let appendix = false;
  const letter = () => String.fromCharCode(64 + Math.max(1, counters[0] ?? 0));
  const add = (id: string | undefined, label: Label) => {
    if (!id) return;
    if (ctx.labels.has(id)) ctx.diagnostics.push({ severity: 'warning', message: `Duplicate label #${id}` });
    else ctx.labels.set(id, label);
  };
  const item = (kind: 'fig' | 'tbl' | 'eq', id: string | undefined) => {
    if (!id?.startsWith(`${kind}-`)) return;
    items[kind]++;
    add(id, { kind, number: appendix ? `${letter()}.${items[kind]}` : String(items[kind]) });
  };

  walk(tokens, (t) => {
    if (t.type === 'fence' && /^\{=(latex|tex)\}/.test(t.info.trim()) && /\\appendix\b/.test(t.content)) {
      appendix = true;
      counters.fill(0);
      items.fig = items.tbl = items.eq = 0;
    } else if (t.type === 'fence' && t.info.trim() === '{=html}') {
      ctx.diagnostics.push({ severity: 'info', message: 'Raw HTML blocks are not shown in the preview.' });
    } else if (t.type === 'fence' && /^\{(?!=)/.test(t.info.trim())) {
      if (!ctx.diagnostics.some((d) => d.message.startsWith('Code cells')))
        ctx.diagnostics.push({ severity: 'info', message: 'Code cells are not run in the preview; their source is shown.' });
    } else if (t.type === 'heading_open' || t.type === 'heading_close') {
      const level = Number(t.tag.slice(1));
      t.tag = `h${Math.min(6, level + 1)}`;
      if (t.type === 'heading_close') return;
      const attrs = (t.meta?.attrs as Attrs | undefined) ?? { classes: [], kv: {} };
      if (!ctx.numberSections || attrs.classes.includes('unnumbered') || t.meta?.calloutTitle) return;
      counters[level - 1] = (counters[level - 1] ?? 0) + 1;
      counters.fill(0, level);
      if (appendix && level === 1) items.fig = items.tbl = items.eq = 0;
      const parts = counters.slice(0, level).map((n, i) => (appendix && i === 0 ? letter() : String(n)));
      const num = appendix ? `Appendix ${parts.join('.')}` : parts.join('.');
      t.meta = { ...t.meta, number: num };
      if (attrs.id?.startsWith('sec-')) add(attrs.id, { kind: 'sec', number: num });
    } else if (t.type === 'figure') {
      item('fig', ((t.meta?.image as Token).meta?.attrs as Attrs | undefined)?.id);
    } else if (t.type === 'fenced_div_open') {
      const id = (t.meta?.attrs as Attrs).id;
      item('fig', id);
      item('tbl', id);
    } else if (t.type === 'table_open') {
      item('tbl', (t.meta?.attrs as Attrs | undefined)?.id);
    } else if (t.type === 'math_block' || t.type === 'math_display') {
      item('eq', (t.meta?.attrs as Attrs | undefined)?.id);
    }
  });
}

async function loadBibliography(
  meta: Meta,
  entryDir: string,
  project: ProjectSource,
  diagnostics: Diagnostic[],
): Promise<{ items: Record<string, CslItem>; signature: string }> {
  const items: Record<string, CslItem> = {};
  let signature = '';
  for (const raw of list(meta.bibliography).map(str)) {
    if (!raw) continue;
    const path = [resolvePath(entryDir, raw), resolvePath('', raw)].find((p) => p !== undefined && project.files.includes(p));
    if (!path) {
      diagnostics.push({ severity: 'warning', message: `Bibliography not found: ${raw}` });
      continue;
    }
    let text: string;
    try {
      text = await project.readText(path);
    } catch {
      diagnostics.push({ severity: 'warning', message: `Could not read the bibliography ${path}` });
      continue;
    }
    signature += `${path}\n${text}\n`;
    if (/\.json$/i.test(path)) {
      try {
        for (const item of list(JSON.parse(text))) {
          if (isRecord(item) && typeof item.id === 'string' && typeof item.type === 'string') items[item.id] = item as CslItem;
        }
      } catch {
        diagnostics.push({ severity: 'warning', path, message: `${path} is not valid CSL-JSON` });
      }
      continue;
    }
    if (!/\.bib$/i.test(path)) {
      diagnostics.push({ severity: 'info', path, message: `Only .bib and CSL-JSON bibliographies are shown in the preview (${path}).` });
      continue;
    }
    const parsed = parseBibtex(text);
    Object.assign(items, parsed.items);
    for (const error of parsed.errors.slice(0, 3)) diagnostics.push({ severity: 'warning', path, message: `${path}: ${error}` });
  }
  return { items, signature };
}

function citations(tokens: Token[][], items: Record<string, CslItem>, signature: string, ctx: RenderContext): string {
  const found: Token[] = [];
  for (const list of tokens) walk(list, (t) => t.type === 'citation' && found.push(t));
  const clusters: Cluster[] = found.map((t) => ({
    refs: (t.meta?.refs as Cluster['refs']).filter((r) => !/^(fig|tbl|eq|sec)-/.test(r.key)),
    inText: t.meta?.inText as boolean,
  }));
  if (!clusters.some((c) => c.refs.length)) return '';
  try {
    const out = formatCitations(items, signature, clusters);
    const missing = new Set(out.missing);
    found.forEach((t, i) => {
      const refs = clusters[i]?.refs ?? [];
      t.meta = { ...t.meta, html: out.clusters[i], missing: refs.map((r) => r.key).filter((k) => missing.has(k)) };
    });
    for (const key of out.missing) ctx.diagnostics.push({ severity: 'warning', message: `No bibliography entry for @${key}` });
    return out.entries.map((e) => `<div class="csl-entry" id="ref-${encodeURIComponent(e.key)}">${e.html.replace(/^<div class="csl-entry">|<\/div>$/g, '')}</div>`).join('\n');
  } catch (err) {
    ctx.diagnostics.push({ severity: 'error', message: `Citations could not be formatted: ${err instanceof Error ? err.message : String(err)}` });
    return '';
  }
}

async function images(tokens: Token[][], meta: Meta, entryDir: string, project: ProjectSource, ctx: RenderContext): Promise<PreviewAsset[]> {
  const found: Token[] = [];
  for (const list of tokens) walk(list, (t) => t.type === 'image' && found.push(t));
  const files = new Set(project.files);
  const defaultExt = str(meta['default-image-extension']);
  const exts = [...new Set([defaultExt, 'png', 'svg', 'jpg', 'jpeg', 'gif', 'webp'].filter((e): e is string => !!e))];
  const assets: PreviewAsset[] = [];
  const pending = new Map<string, Promise<PreviewAsset | undefined>>();
  let total = 0;
  let tooMany = false;

  const resolveImage = (src: string): string | undefined => {
    let decoded = src;
    try {
      decoded = decodeURI(src);
    } catch {
      /* keep the raw value */
    }
    const base = resolvePath(entryDir, decoded);
    if (base === undefined) return undefined;
    const ext = /\.([A-Za-z0-9]+)$/.exec(base)?.[1]?.toLowerCase();
    if (ext && IMAGE_TYPES[ext] && files.has(base)) return base;
    const stem = ext && !IMAGE_TYPES[ext] ? base.slice(0, -(ext.length + 1)) : base;
    for (const e of exts) if (files.has(`${stem}.${e}`)) return `${stem}.${e}`;
    return undefined;
  };

  const load = (path: string) => {
    let p = pending.get(path);
    if (!p) {
      const id = `a${pending.size}`;
      p = project.readBytes(path).then(
        (bytes) => {
          const type = IMAGE_TYPES[/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''];
          if (!type) return undefined;
          if (bytes.length > MAX_IMAGE_BYTES || total + bytes.length > MAX_TOTAL_BYTES) {
            ctx.diagnostics.push({ severity: 'info', path, message: `${path} is too large to show in the preview.` });
            return undefined;
          }
          total += bytes.length;
          return { id, path, type, bytes };
        },
        () => {
          ctx.diagnostics.push({ severity: 'warning', path, message: `Could not read the image ${path}` });
          return undefined;
        },
      );
      pending.set(path, p);
    }
    return p;
  };

  await Promise.all(
    found.map(async (t) => {
      const src = String(t.attrGet('src') ?? '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) {
        ctx.diagnostics.push({ severity: 'info', message: 'Images from outside the repository are not loaded in the preview.' });
        return;
      }
      const path = resolveImage(src);
      if (!path) {
        t.meta = { ...t.meta, shownPath: src };
        ctx.diagnostics.push({
          severity: 'warning',
          message: /\.(pdf|eps|ps|tiff?)$/i.test(src)
            ? `${src}: the preview shows PNG, JPEG, GIF, WebP or SVG figures only.`
            : `Image not found: ${src}`,
        });
        return;
      }
      if (!pending.has(path) && pending.size >= MAX_ASSETS) {
        if (!tooMany) ctx.diagnostics.push({ severity: 'info', message: `The preview shows at most ${MAX_ASSETS} figures; more than ${MAX_ASSETS} figures are not shown.` });
        tooMany = true;
        t.meta = { ...t.meta, shownPath: path };
        return;
      }
      const asset = await load(path);
      t.meta = { ...t.meta, shownPath: path, asset: asset?.id };
    }),
  );
  for (const p of pending.values()) {
    const a = await p;
    if (a) assets.push(a);
  }
  return assets.sort((x, y) => Number(x.id.slice(1)) - Number(y.id.slice(1)));
}

/** Renders the project's entry document to preview HTML. Never throws. */
export async function render(project: ProjectSource): Promise<RenderResult> {
  const diagnostics: Diagnostic[] = [];
  try {
    return await renderProject(project, diagnostics);
  } catch (err) {
    diagnostics.push({ severity: 'error', message: `The preview failed: ${err instanceof Error ? err.message : String(err)}` });
    return { html: '', assets: [], diagnostics };
  }
}

async function renderProject(project: ProjectSource, diagnostics: Diagnostic[]): Promise<RenderResult> {
  const configPath = ['_quarto.yml', '_quarto.yaml'].find((p) => project.files.includes(p));
  const config = configPath ? parseYaml(await project.readText(configPath), configPath, diagnostics) : {};
  const chosen = project.entry && /\.(qmd|md)$/.test(project.entry) && project.files.includes(project.entry) ? project.entry : undefined;
  const entry = chosen ?? findEntry(project.files, config);
  if (!entry) {
    diagnostics.push({ severity: 'info', message: 'Nothing to preview: add an index.qmd or list the entry file in _quarto.yml.' });
    return { html: '', assets: [], diagnostics };
  }

  const { yaml, body } = splitFrontMatter(await project.readText(entry));
  const front = yaml ? parseYaml(yaml, entry, diagnostics) : {};
  const format = isRecord(config.format) && isRecord(config.format.html) ? config.format.html : {};
  const meta: Meta = { ...config, ...format, ...front };
  const entryDir = dirname(entry);

  const expanded = removeShortcodes(await expandIncludes(body, entry, project, diagnostics), diagnostics);
  const ctx: RenderContext = {
    diagnostics,
    labels: new Map(),
    crossref: crossrefConfig({ crossref: { ...(isRecord(config.crossref) ? config.crossref : {}), ...(isRecord(front.crossref) ? front.crossref : {}) } }),
    numberSections: meta['number-sections'] !== false,
    references: '',
    referencesPlaced: false,
    assets: new Map(),
    macros: {},
  };
  const env: Env = { galley: ctx };
  const abstractEnv: Env = { galley: ctx };
  const tokens = md().parse(expanded, env);
  const abstractSource = str(front.abstract);
  const abstractTokens = abstractSource ? md().parse(abstractSource, abstractEnv) : [];

  number(tokens, ctx);
  const bib = await loadBibliography(meta, entryDir, project, diagnostics);
  ctx.references = citations([abstractTokens, tokens], bib.items, bib.signature, ctx);
  const assets = await images([abstractTokens, tokens], meta, entryDir, project, ctx);

  const abstractHtml = abstractTokens.length ? md().renderer.render(abstractTokens, md().options, abstractEnv) : '';
  let html = md().renderer.render(tokens, md().options, env);
  if (ctx.references && !ctx.referencesPlaced) {
    html += `<h2 class="unnumbered">References</h2>\n<div id="refs" class="references">${ctx.references}</div>\n`;
  }
  const title = renderTitleBlock(front, (s) => md().renderInline(s, { galley: ctx }), abstractHtml);
  const full = title + html;
  if (full.length > MAX_HTML_LENGTH) {
    diagnostics.push({ severity: 'error', message: 'This document is too large to preview.' });
    return { html: '', assets: [], diagnostics };
  }
  return { html: full, assets, diagnostics };
}

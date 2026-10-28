import { load } from 'js-yaml';
import type { ProjectSource } from '../render';
import { dirname, resolvePath, splitFrontMatter, stripComments } from '../render/source';
import { DEFAULT_ACCEPT, DEFAULT_UPLOAD_MB, MAX_EDITABLE, MAX_TEXT, type GalleyConfig } from './schema';
import { globError } from './glob';

// Suggests a first `.galley.yml` from what the repository already contains:
// the entry from `_quarto.yml`, the files reachable from it through
// `{{< include >}}`, the bibliography, a `figures/` upload folder, and each
// included file's first heading as its label. The admin reviews it before saving.

const MAX_VISITED = MAX_EDITABLE;
const MAX_DEPTH = 16;
const INCLUDE = /\{\{<\s*include\s+([^>]*?)\s*>\}\}/g;

type Meta = Record<string, unknown>;
const isRecord = (v: unknown): v is Meta => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function parse(text: string): Meta {
  try {
    const value = load(text, { maxAliases: 0, maxDepth: 20 });
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

// Control characters are not allowed in `.galley.yml` text.
// eslint-disable-next-line no-control-regex
const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT);

async function readMeta(project: ProjectSource, path: string): Promise<Meta> {
  try {
    return parse(await project.readText(path));
  } catch {
    return {};
  }
}

/** The entry document, found the same way as the preview finds it. */
export function entryFrom(files: readonly string[], quarto: Meta): string | undefined {
  const projectMeta = isRecord(quarto.project) ? quarto.project : {};
  const listed = list(projectMeta.render).find(
    (p): p is string => typeof p === 'string' && /\.(qmd|md)$/.test(p) && !p.includes('*') && files.includes(p),
  );
  return listed ?? ['index.qmd', 'index.md'].find((p) => files.includes(p));
}

/** The first heading's text, without attributes such as `{#sec-intro}`. */
export function firstHeading(text: string): string | undefined {
  let fence: string | undefined;
  for (const line of stripComments(splitFrontMatter(text).body).split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker.startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*(\{[^}]*\})?\s*#*\s*$/.exec(line);
    const heading = m?.[1]?.trim();
    if (heading) return clean(heading) || undefined;
  }
  return undefined;
}

async function reachable(project: ProjectSource, entry: string): Promise<Map<string, string>> {
  const known = new Set(project.files);
  const seen = new Map<string, string>();
  const visit = async (path: string, depth: number) => {
    if (seen.has(path) || seen.size >= MAX_VISITED || depth > MAX_DEPTH) return;
    let text: string;
    try {
      text = await project.readText(path);
    } catch {
      return;
    }
    seen.set(path, text);
    for (const m of stripComments(text).matchAll(INCLUDE)) {
      const raw = (m[1] ?? '').replace(/^["']|["']$/g, '');
      const target = [resolvePath(dirname(path), raw), resolvePath('', raw)].find((c) => c !== undefined && known.has(c));
      if (target) await visit(target, depth + 1);
    }
  };
  await visit(entry, 0);
  return seen;
}

/** Turns file paths into patterns: a folder whose .qmd files are all listed becomes `folder/*.qmd`. */
function collapse(paths: string[], files: readonly string[]): string[] {
  const out = new Set<string>();
  const byFolder = new Map<string, string[]>();
  for (const p of paths) {
    const dir = dirname(p);
    if (dir && p.endsWith('.qmd')) byFolder.set(dir, [...(byFolder.get(dir) ?? []), p]);
    else out.add(p);
  }
  for (const [dir, listed] of byFolder) {
    const all = files.filter((f) => dirname(f) === dir && f.endsWith('.qmd') && !f.slice(dir.length + 1).startsWith('.'));
    const pattern = `${dir}/*.qmd`;
    if (listed.length >= 2 && all.length === listed.length && !globError(pattern)) out.add(pattern);
    else for (const p of listed) out.add(p);
  }
  return [...out];
}

export async function suggestConfig(project: ProjectSource): Promise<GalleyConfig> {
  const files = project.files;
  const quartoPath = ['_quarto.yml', '_quarto.yaml'].find((p) => files.includes(p));
  const quarto = quartoPath ? await readMeta(project, quartoPath) : {};
  const entry = entryFrom(files, quarto);
  const config: GalleyConfig = { version: 1, editable: [], uploads: [], labels: {}, preview: { autoCompile: false } };
  if (!entry) return config;
  config.entry = entry;

  const texts = await reachable(project, entry);
  const front = parse(splitFrontMatter(texts.get(entry) ?? '').yaml ?? '');
  if (typeof front.title === 'string' && front.title.trim()) config.title = clean(front.title);

  const bibs = [...list(quarto.bibliography), ...list(front.bibliography)]
    .filter((b): b is string => typeof b === 'string')
    .map((b) => resolvePath(dirname(entry), b))
    .filter((b): b is string => b !== undefined && files.includes(b));

  const others = [...new Set([...texts.keys(), ...bibs])].filter((p) => p !== entry && !globError(p));
  config.editable = [entry, ...collapse(others, files).sort()].slice(0, MAX_EDITABLE);

  for (const [path, text] of texts) {
    if (path === entry) continue;
    const heading = firstHeading(text);
    if (heading) config.labels[path] = heading;
  }

  if (files.some((f) => f.startsWith('figures/'))) {
    config.uploads.push({ folder: 'figures/', accept: [...DEFAULT_ACCEPT], maxSizeMb: DEFAULT_UPLOAD_MB });
  }
  return config;
}

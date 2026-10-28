import { dump, load } from 'js-yaml';
import { globError, isPlainPath } from './glob';
import { CONFIG_PATH } from './project';

// `.galley.yml`: galley's project configuration, versioned in the paper
// repository. Anyone with write access can change it on GitHub, so it is
// untrusted input: it is parsed with the safe core schema (no custom tags, no
// aliases), checked field by field, and can only narrow what galley shows.
// GitHub permissions still decide what anyone can read or write.

export { CONFIG_PATH };

export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_EDITABLE = 200;
export const MAX_UPLOADS = 20;
export const MAX_ACCEPT = 20;
export const MAX_LABELS = 500;
export const MAX_TEXT = 120;
export const MAX_UPLOAD_MB = 25;
export const DEFAULT_ACCEPT = ['png', 'jpg', 'jpeg', 'svg', 'pdf'];
export const DEFAULT_UPLOAD_MB = 10;

export interface UploadRule {
  /** Repository folder with a trailing slash, e.g. `figures/`. */
  folder: string;
  /** Lower-case file extensions without the dot. */
  accept: string[];
  maxSizeMb: number;
}

export interface GalleyConfig {
  version: 1;
  title?: string;
  /** Entry document; when absent the preview uses `_quarto.yml` or `index.qmd`. */
  entry?: string;
  /** Paths and patterns co-authors see and edit in galley. */
  editable: string[];
  /** Folders that accept uploads (used by figure upload). */
  uploads: UploadRule[];
  /** Friendly names for files, keyed by path. */
  labels: Record<string, string>;
  preview: { autoCompile: boolean };
}

export interface ConfigProblem {
  severity: 'error' | 'warning';
  message: string;
}

export interface ParsedConfig {
  /** Undefined when there is any error; callers then use safe defaults. */
  config?: GalleyConfig;
  problems: ConfigProblem[];
}

type Record_ = Record<string, unknown>;
const isRecord = (v: unknown): v is Record_ => typeof v === 'object' && v !== null && !Array.isArray(v);

const TOP_KEYS = ['version', 'title', 'entry', 'editable', 'uploads', 'labels', 'preview'];
const UPLOAD_KEYS = ['folder', 'accept', 'max_size_mb'];
const PREVIEW_KEYS = ['auto_compile'];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export function parseConfig(text: string): ParsedConfig {
  const problems: ConfigProblem[] = [];
  const error = (message: string) => problems.push({ severity: 'error', message });
  const warn = (message: string) => problems.push({ severity: 'warning', message });

  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) {
    error(`${CONFIG_PATH} is larger than ${MAX_CONFIG_BYTES / 1024} KB.`);
    return { problems };
  }
  let doc: unknown;
  try {
    // js-yaml refuses an empty document; it is reported as "not a mapping" below.
    doc = text.trim() === '' ? undefined : load(text, { maxAliases: 0, maxDepth: 20, filename: CONFIG_PATH });
  } catch (err) {
    const reason = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
    error(`${CONFIG_PATH} is not valid YAML: ${reason}`);
    return { problems };
  }
  if (!isRecord(doc)) {
    error(`${CONFIG_PATH} must be a mapping of settings (key: value).`);
    return { problems };
  }
  for (const key of Object.keys(doc)) if (!TOP_KEYS.includes(key)) warn(`Unknown setting "${key}" is ignored.`);

  const config: GalleyConfig = { version: 1, editable: [], uploads: [], labels: {}, preview: { autoCompile: false } };

  if (doc.version === undefined) error('"version" is missing; use "version: 1".');
  else if (doc.version !== 1) error('Only "version: 1" is supported.');

  const text_ = (value: unknown, field: string): string | undefined => {
    if (typeof value !== 'string') {
      error(`${field} must be text.`);
      return undefined;
    }
    if (CONTROL.test(value)) {
      error(`${field} contains control characters.`);
      return undefined;
    }
    if (value.length > MAX_TEXT) {
      error(`${field} is longer than ${MAX_TEXT} characters.`);
      return undefined;
    }
    return value;
  };

  if (doc.title !== undefined) config.title = text_(doc.title, '"title"');

  if (doc.entry !== undefined) {
    if (typeof doc.entry !== 'string') error('"entry" must be text.');
    else {
      const problem = globError(doc.entry);
      if (problem) error(`"entry" (${doc.entry}) ${problem}`);
      else if (!isPlainPath(doc.entry) || !/\.(qmd|md)$/i.test(doc.entry)) {
        error('"entry" must be one .qmd or .md file, without wildcards.');
      } else config.entry = doc.entry;
    }
  }

  if (doc.editable === undefined) error('"editable" is missing: list the files co-authors can edit.');
  else if (!Array.isArray(doc.editable)) error('"editable" must be a list of file paths or patterns.');
  else if (doc.editable.length > MAX_EDITABLE) error(`"editable" lists more than ${MAX_EDITABLE} entries.`);
  else {
    doc.editable.forEach((item, i) => {
      if (typeof item !== 'string') return void error(`"editable" item ${i + 1} must be text.`);
      const problem = globError(item);
      if (problem) return void error(`"editable" item ${i + 1} (${item}): ${problem}`);
      if (!config.editable.includes(item)) config.editable.push(item);
    });
  }

  if (doc.uploads !== undefined) {
    if (!Array.isArray(doc.uploads)) error('"uploads" must be a list of upload folders.');
    else if (doc.uploads.length > MAX_UPLOADS) error(`"uploads" lists more than ${MAX_UPLOADS} folders.`);
    else doc.uploads.forEach((item, i) => parseUpload(item, `"uploads" item ${i + 1}`, config, error, warn));
  }

  if (doc.labels !== undefined) {
    if (!isRecord(doc.labels)) error('"labels" must map file paths to names.');
    else if (Object.keys(doc.labels).length > MAX_LABELS) error(`"labels" has more than ${MAX_LABELS} entries.`);
    else {
      for (const [path, name] of Object.entries(doc.labels)) {
        const problem = globError(path) ?? (isPlainPath(path) ? undefined : 'must be one file, without wildcards.');
        if (problem) {
          error(`"labels" key (${path}) ${problem}`);
          continue;
        }
        const value = text_(name, `"labels" name for ${path}`);
        if (value !== undefined) config.labels[path] = value;
      }
    }
  }

  if (doc.preview !== undefined) {
    if (!isRecord(doc.preview)) error('"preview" must be a mapping.');
    else {
      for (const key of Object.keys(doc.preview)) if (!PREVIEW_KEYS.includes(key)) warn(`Unknown setting "preview.${key}" is ignored.`);
      const auto = doc.preview.auto_compile;
      if (auto !== undefined && typeof auto !== 'boolean') error('"preview.auto_compile" must be true or false.');
      else if (auto !== undefined) config.preview.autoCompile = auto;
    }
  }

  return problems.some((p) => p.severity === 'error') ? { problems } : { config, problems };
}

function parseUpload(
  item: unknown,
  where: string,
  config: GalleyConfig,
  error: (m: string) => void,
  warn: (m: string) => void,
): void {
  if (!isRecord(item)) return void error(`${where} must be a mapping with a "folder".`);
  for (const key of Object.keys(item)) if (!UPLOAD_KEYS.includes(key)) warn(`${where}: unknown setting "${key}" is ignored.`);
  if (item.folder === undefined) return void error(`${where}: "folder" is missing.`);
  if (typeof item.folder !== 'string') return void error(`${where}: "folder" must be text.`);
  const folder = item.folder.replace(/\/+$/, '');
  const problem = globError(folder);
  if (problem) return void error(`${where}: "folder" (${item.folder}) ${problem}`);
  if (!isPlainPath(folder)) return void error(`${where}: "folder" must be a plain folder, without wildcards.`);
  if (folder.split('/').some((seg) => seg.startsWith('.'))) {
    return void error(`${where}: "folder" must not be a hidden folder (a name starting with ".").`);
  }

  let accept = DEFAULT_ACCEPT;
  if (item.accept !== undefined) {
    if (!Array.isArray(item.accept)) return void error(`${where}: "accept" must be a list of file extensions.`);
    if (item.accept.length > MAX_ACCEPT) return void error(`${where}: "accept" lists more than ${MAX_ACCEPT} types.`);
    accept = [];
    for (const [i, ext] of item.accept.entries()) {
      if (typeof ext !== 'string' || !/^[A-Za-z0-9]{1,10}$/.test(ext)) {
        return void error(`${where}: "accept" item ${i + 1} must be a file extension such as png, without a dot.`);
      }
      const lower = ext.toLowerCase();
      if (!accept.includes(lower)) accept.push(lower);
    }
  }

  let maxSizeMb = DEFAULT_UPLOAD_MB;
  if (item.max_size_mb !== undefined) {
    const size = item.max_size_mb;
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_MB) {
      return void error(`${where}: "max_size_mb" must be a number between 0 and ${MAX_UPLOAD_MB}.`);
    }
    maxSizeMb = size;
  }

  const normalized = `${folder}/`;
  if (config.uploads.some((u) => u.folder === normalized)) return void error(`${where}: folder ${normalized} is listed twice.`);
  config.uploads.push({ folder: normalized, accept: [...accept], maxSizeMb });
}

/** Writes a config as YAML with a fixed key order and no comments. */
export function serializeConfig(config: GalleyConfig): string {
  const out: Record_ = { version: 1 };
  if (config.title !== undefined && config.title !== '') out.title = config.title;
  if (config.entry !== undefined && config.entry !== '') out.entry = config.entry;
  out.editable = [...config.editable];
  if (config.uploads.length > 0) {
    out.uploads = config.uploads.map((u) => ({ folder: u.folder, accept: [...u.accept], max_size_mb: u.maxSizeMb }));
  }
  const labels = Object.keys(config.labels)
    .filter((k) => config.labels[k])
    .sort();
  if (labels.length > 0) out.labels = Object.fromEntries(labels.map((k) => [k, config.labels[k]]));
  out.preview = { auto_compile: config.preview.autoCompile };
  return dump(out, { lineWidth: -1, noRefs: true });
}

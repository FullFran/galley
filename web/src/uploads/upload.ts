import type { UploadRule } from '../config/schema';
import type { FileChange } from '../domain';
import { slugify } from '../structure/slug';

// Figure upload into the `.galley.yml` upload folders. Everything here is a
// pure decision: the name, type and size are checked before the file is read,
// the bytes are checked against the extension after reading, and the upload
// becomes a base64 change in the person's next save.

export type UploadProblem =
  | { kind: 'name' }
  | { kind: 'empty' }
  | { kind: 'type'; accept: string[] }
  | { kind: 'size'; maxSizeMb: number }
  /** The bytes are not what the extension says (checked after reading). */
  | { kind: 'content' };

/** An upload waiting for the next save. */
export interface PendingUpload {
  id: number;
  path: string;
  bytes: Uint8Array;
  /** True when it overwrites a file already in the repository. */
  replace: boolean;
}

export const MAX_NAME = 100;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * A safe file name from what the browser reports: only the base name (any
 * folder part is dropped), transliterated, with letters, digits, `-`, `_` and
 * one `.` before a lower-case extension. Undefined when no stem is left.
 */
export function cleanFileName(name: string): string | undefined {
  const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  const rawStem = dot >= 0 ? base.slice(0, dot) : base;
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const stem = rawStem
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, MAX_NAME - ext.length - 1);
  if (!stem) return undefined;
  return ext ? `${stem}.${ext}` : stem;
}

/** Checks name, type and size; the file has not been read yet. */
export function checkUpload(file: { name: string; size: number }, rule: UploadRule): UploadProblem | undefined {
  if (!cleanFileName(file.name)) return { kind: 'name' };
  const ext = extensionOf(file.name);
  if (!ext || !rule.accept.includes(ext)) return { kind: 'type', accept: rule.accept };
  if (file.size === 0) return { kind: 'empty' };
  if (file.size > rule.maxSizeMb * 1024 * 1024) return { kind: 'size', maxSizeMb: rule.maxSizeMb };
  return undefined;
}

const starts = (bytes: Uint8Array, sig: number[]) => sig.every((b, i) => bytes[i] === b);
const SIGNATURES: Record<string, number[][]> = {
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  gif: [[0x47, 0x49, 0x46, 0x38]],
  webp: [[0x52, 0x49, 0x46, 0x46]],
  pdf: [[0x25, 0x50, 0x44, 0x46, 0x2d]],
};

/**
 * True when the bytes plausibly are the type the extension names. Types
 * without a known signature are accepted (the folder's `accept` list already
 * allowed them).
 */
export function checkContent(bytes: Uint8Array, name: string): boolean {
  const ext = extensionOf(name);
  if (ext === 'svg') {
    const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 512)).replace(/^\ufeff/, '').trimStart();
    return head.startsWith('<');
  }
  const sigs = SIGNATURES[ext];
  return sigs === undefined || sigs.some((s) => starts(bytes, s));
}

/** `figures/a.png`, or the first free `figures/a-2.png`, `figures/a-3.png`. */
export function keepBothPath(path: string, exists: (path: string) => boolean): string {
  if (!exists(path)) return path;
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const cut = dot > slash ? dot : path.length;
  for (let n = 2; ; n += 1) {
    const next = `${path.slice(0, cut)}-${n}${path.slice(cut)}`;
    if (!exists(next)) return next;
  }
}

/** The path from the folder of `fromFile` to `path`, both from the repository root. */
export function relativePath(fromFile: string, path: string): string {
  const from = fromFile.split('/').slice(0, -1);
  const to = path.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i += 1;
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
}

export function figureId(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return `fig-${slugify(dot > 0 ? name.slice(0, dot) : name) || 'figure'}`;
}

/** `![Caption](figures/a.png){#fig-a}`, the path relative to `from` (the entry, where includes are expanded). */
export function figureMarkdown(path: string, caption: string, from = ''): string {
  const text = caption
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[[\]\\]/g, (c) => `\\${c}`);
  return `![${text}](${relativePath(from, path)}){#${figureId(path)}}`;
}

/** What dropping an image into the editor inserts at the drop point. */
export function dropInsertion(path: string, from = ''): string {
  return figureMarkdown(path, '', from);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function uploadChange(upload: { path: string; bytes: Uint8Array }): FileChange {
  return { path: upload.path, content: bytesToBase64(upload.bytes), encoding: 'base64' };
}

/** The upload folder a path belongs to, if any. */
export function ruleForFolder(rules: readonly UploadRule[], folder: string): UploadRule | undefined {
  const normalized = folder.endsWith('/') ? folder : `${folder}/`;
  return rules.find((r) => r.folder === normalized);
}

/** Image types the dialog previews (as <img>, never inline SVG). */
export const PREVIEWABLE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
export const imageType = (name: string): string | undefined => MIME[extensionOf(name)];

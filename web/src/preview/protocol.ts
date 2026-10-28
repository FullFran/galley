// Messages between galley and the sandboxed preview frame. The frame has an
// opaque origin, so postMessage is the only channel. Both sides validate every
// message against these exact shapes and drop anything else.

export const PREVIEW_RENDER = 'galley-preview:render';
export const FRAME_READY = 'galley-preview:ready';
export const PREVIEW_SCROLL = 'galley-preview:scroll';

export const MAX_HTML_LENGTH = 8 * 1024 * 1024;
export const MAX_ASSETS = 500;
export const ASSET_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'] as const;
const ASSET_ID = /^a\d{1,4}$/;

export interface FrameAsset {
  /** Matches the `data-galley-asset` attribute of the images that show it. */
  id: string;
  type: (typeof ASSET_TYPES)[number];
  bytes: Uint8Array;
}

/** Parent to frame: replace the preview content. */
export interface RenderMessage {
  type: typeof PREVIEW_RENDER;
  seq: number;
  html: string;
  assets: FrameAsset[];
}

/**
 * Parent to frame: scroll to a heading, by its id when it has one, otherwise
 * by its text. The frame only reads these two strings to look up an element.
 */
export interface ScrollMessage {
  type: typeof PREVIEW_SCROLL;
  id: string;
  text: string;
}

export const MAX_SCROLL_TEXT = 500;
const HEADING_ID = /^[\w:.-]{0,200}$/;

/** Frame to parent: the frame script is running and listening. */
export interface ReadyMessage {
  type: typeof FRAME_READY;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactly(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}

function parseAsset(value: unknown): FrameAsset | undefined {
  if (!isRecord(value) || !hasExactly(value, ['id', 'type', 'bytes'])) return undefined;
  const { id, type, bytes } = value;
  if (typeof id !== 'string' || !ASSET_ID.test(id)) return undefined;
  if (!ASSET_TYPES.some((t) => t === type)) return undefined;
  if (!(bytes instanceof Uint8Array)) return undefined;
  return { id, type: type as FrameAsset['type'], bytes };
}

export function parseRenderMessage(data: unknown): RenderMessage | undefined {
  if (!isRecord(data) || !hasExactly(data, ['type', 'seq', 'html', 'assets'])) return undefined;
  const { type, seq, html, assets } = data;
  if (type !== PREVIEW_RENDER) return undefined;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return undefined;
  if (typeof html !== 'string' || html.length > MAX_HTML_LENGTH) return undefined;
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) return undefined;
  const parsed: FrameAsset[] = [];
  for (const asset of assets) {
    const a = parseAsset(asset);
    if (!a) return undefined;
    parsed.push(a);
  }
  return { type, seq, html, assets: parsed };
}

export function parseScrollMessage(data: unknown): ScrollMessage | undefined {
  if (!isRecord(data) || !hasExactly(data, ['type', 'id', 'text'])) return undefined;
  const { type, id, text } = data;
  if (type !== PREVIEW_SCROLL) return undefined;
  if (typeof id !== 'string' || !HEADING_ID.test(id)) return undefined;
  if (typeof text !== 'string' || text.length > MAX_SCROLL_TEXT) return undefined;
  return { type, id, text };
}

export function parseFrameMessage(data: unknown): ReadyMessage | undefined {
  if (!isRecord(data) || !hasExactly(data, ['type']) || data.type !== FRAME_READY) return undefined;
  return { type: FRAME_READY };
}

/**
 * Decides when galley may post to the frame. The frame sends ready while its
 * script runs, before the iframe's load event, so at most one ready is
 * accepted per load; a load without a ready since the previous one means the
 * frame now holds some other document, and posting stops until a fresh ready.
 */
export function createReadyGate() {
  let readySinceLoad = false;
  let live = false;
  return {
    /** Returns true when this ready is accepted and the content should be (re)posted. */
    ready(): boolean {
      if (readySinceLoad) return false;
      readySinceLoad = true;
      live = true;
      return true;
    },
    loaded(): void {
      if (!readySinceLoad) live = false;
      readySinceLoad = false;
    },
    canPost(): boolean {
      return live;
    },
  };
}

// Source tags and selection (comments from the preview, click-to-jump). The
// renderer tags each block with `data-src="path:line"`; the frame reports
// selections and double-clicks with those tags, and galley asks it to reveal
// the block of a source line. Paths follow the comment API's rules.

/** Frame to parent: the reader selected text (empty text: the selection was cleared). */
export const FRAME_SELECTION = 'galley-preview:selection';
/** Frame to parent: the reader double-clicked a block; jump to its source. */
export const FRAME_JUMP = 'galley-preview:jump';
/** Parent to frame: scroll to the block of this source line and flash it. */
export const PREVIEW_REVEAL = 'galley-preview:reveal';

export const MAX_SELECTION_TEXT = 4000;
const MAX_PATH = 512;
const MAX_LINE = 1_000_000;
// C0 and C1 controls, the backslash, and format characters (bidi controls among them).
const BAD_PATH_CHAR = /[\p{Cc}\\]|\p{Cf}/u;

export interface SelectionMessage {
  type: typeof FRAME_SELECTION;
  text: string;
  /** Tag of the block where the selection starts, `path:line`; empty when cleared. */
  src: string;
  /** `path:line` of the last source line of the block where it ends; empty when cleared. */
  endSrc: string;
}

export interface JumpMessage {
  type: typeof FRAME_JUMP;
  src: string;
}

export interface RevealMessage {
  type: typeof PREVIEW_REVEAL;
  path: string;
  line: number;
}

export function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH || path.startsWith('/') || BAD_PATH_CHAR.test(path)) return false;
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

const isLine = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_LINE;

/** Parses a `path:line` source tag. */
export function parseSrc(value: string): { path: string; line: number } | undefined {
  const i = value.lastIndexOf(':');
  if (i <= 0) return undefined;
  const path = value.slice(0, i);
  const digits = value.slice(i + 1);
  if (!/^[1-9]\d{0,6}$/.test(digits)) return undefined;
  const line = Number(digits);
  return isSafePath(path) && isLine(line) ? { path, line } : undefined;
}

export function parseSelectionMessage(data: unknown): SelectionMessage | undefined {
  if (!isRecord(data) || !hasExactly(data, ['type', 'text', 'src', 'endSrc'])) return undefined;
  const { type, text, src, endSrc } = data;
  if (type !== FRAME_SELECTION || typeof text !== 'string' || typeof src !== 'string' || typeof endSrc !== 'string') return undefined;
  if (text.length > MAX_SELECTION_TEXT) return undefined;
  if (text === '') return src === '' && endSrc === '' ? { type, text, src, endSrc } : undefined;
  if (!parseSrc(src) || !parseSrc(endSrc)) return undefined;
  return { type, text, src, endSrc };
}

export function parseJumpMessage(data: unknown): JumpMessage | undefined {
  if (!isRecord(data) || !hasExactly(data, ['type', 'src'])) return undefined;
  const { type, src } = data;
  if (type !== FRAME_JUMP || typeof src !== 'string' || !parseSrc(src)) return undefined;
  return { type, src };
}

export function parseRevealMessage(data: unknown): RevealMessage | undefined {
  if (!isRecord(data) || !hasExactly(data, ['type', 'path', 'line'])) return undefined;
  const { type, path, line } = data;
  if (type !== PREVIEW_REVEAL || typeof path !== 'string' || !isSafePath(path) || !isLine(line)) return undefined;
  return { type, path, line };
}

// Messages between galley and the sandboxed preview frame. The frame has an
// opaque origin, so postMessage is the only channel. Both sides validate every
// message against these exact shapes and drop anything else.

export const PREVIEW_RENDER = 'galley-preview:render';
export const FRAME_READY = 'galley-preview:ready';

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

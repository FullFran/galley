// Figures opened from the editor are shown from a data: URL: the app's CSP
// allows `img-src 'self' data:`, and an <img> never runs scripts, SVG included.

export const MAX_FIGURE_BYTES = 10 * 1024 * 1024;

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

/** A data: URL for an image figure; undefined for PDFs, other types and files over the size limit. */
export function figureDataUrl(bytes: Uint8Array, path: string): string | undefined {
  const type = TYPES[/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''];
  if (!type || bytes.length > MAX_FIGURE_BYTES) return undefined;
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:${type};base64,${btoa(binary)}`;
}

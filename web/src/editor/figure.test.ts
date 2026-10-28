import { describe, expect, it } from 'vitest';
import { MAX_FIGURE_BYTES, figureDataUrl } from './figure';

describe('figure data URL', () => {
  it('encodes image bytes with the type from the extension', () => {
    expect(figureDataUrl(new Uint8Array([104, 105]), 'figures/a.PNG')).toBe('data:image/png;base64,aGk=');
    expect(figureDataUrl(new Uint8Array([60]), 'a.svg')).toBe('data:image/svg+xml;base64,PA==');
  });

  it('refuses PDFs, unknown types and files over the limit', () => {
    expect(figureDataUrl(new Uint8Array([1]), 'a.pdf')).toBeUndefined();
    expect(figureDataUrl(new Uint8Array([1]), 'a.html')).toBeUndefined();
    expect(figureDataUrl(new Uint8Array(MAX_FIGURE_BYTES + 1), 'a.png')).toBeUndefined();
  });
});

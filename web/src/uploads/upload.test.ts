import { describe, expect, it } from 'vitest';
import type { UploadRule } from '../config/schema';
import {
  bytesToBase64,
  checkContent,
  checkUpload,
  cleanFileName,
  dropInsertion,
  figureId,
  figureMarkdown,
  keepBothPath,
  relativePath,
  uploadChange,
} from './upload';

const rule: UploadRule = { folder: 'figures/', accept: ['png', 'jpg', 'svg'], maxSizeMb: 1 };

describe('upload validation (before the file is read)', () => {
  it('accepts a file of an allowed type within the size limit', () => {
    expect(checkUpload({ name: 'Glow Curve.PNG', size: 1000 }, rule)).toBeUndefined();
  });

  it('refuses a type the folder does not accept', () => {
    expect(checkUpload({ name: 'data.pdf', size: 10 }, rule)).toEqual({ kind: 'type', accept: ['png', 'jpg', 'svg'] });
    expect(checkUpload({ name: 'noextension', size: 10 }, rule)).toEqual({ kind: 'type', accept: ['png', 'jpg', 'svg'] });
  });

  it('refuses a file over max_size_mb, and an empty file', () => {
    expect(checkUpload({ name: 'a.png', size: 1024 * 1024 + 1 }, rule)).toEqual({ kind: 'size', maxSizeMb: 1 });
    expect(checkUpload({ name: 'a.png', size: 1024 * 1024 }, rule)).toBeUndefined();
    expect(checkUpload({ name: 'a.png', size: 0 }, rule)).toEqual({ kind: 'empty' });
  });

  it('refuses names that cannot become a safe file name', () => {
    expect(checkUpload({ name: '.png', size: 10 }, rule)).toEqual({ kind: 'name' });
    expect(checkUpload({ name: '???.png', size: 10 }, rule)).toEqual({ kind: 'name' });
  });
});

describe('cleanFileName', () => {
  it('keeps only the base name, transliterates and lower-cases the extension', () => {
    expect(cleanFileName('Glow Curve.PNG')).toBe('Glow-Curve.png');
    expect(cleanFileName('C:\\Users\\ana\\Señal µ (final).jpg')).toBe('Senal-final.jpg');
    expect(cleanFileName('../../etc/passwd.png')).toBe('passwd.png');
  });

  it('gives undefined for names without a usable stem', () => {
    expect(cleanFileName('.hidden.png')).toBe('hidden.png');
    expect(cleanFileName('...')).toBeUndefined();
    expect(cleanFileName('')).toBeUndefined();
  });
});

describe('checkContent: the bytes match the extension', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  it('accepts matching signatures and refuses others', () => {
    expect(checkContent(png, 'a.png')).toBe(true);
    expect(checkContent(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'a.jpg')).toBe(true);
    expect(checkContent(new TextEncoder().encode('<html>'), 'a.png')).toBe(false);
    expect(checkContent(new TextEncoder().encode('\ufeff  <?xml version="1.0"?><svg/>'), 'a.svg')).toBe(true);
    expect(checkContent(png, 'a.svg')).toBe(false);
    expect(checkContent(new TextEncoder().encode('%PDF-1.7'), 'a.pdf')).toBe(true);
  });
});

describe('name collisions', () => {
  it('keeps both by adding -2, -3 before the extension', () => {
    const taken = new Set(['figures/a.png', 'figures/a-2.png']);
    expect(keepBothPath('figures/a.png', (p) => taken.has(p))).toBe('figures/a-3.png');
    expect(keepBothPath('figures/b.png', (p) => taken.has(p))).toBe('figures/b.png');
    expect(keepBothPath('figures/a-2.png', (p) => taken.has(p))).toBe('figures/a-2-2.png');
  });
});

describe('figure markdown', () => {
  it('derives a fig- id from the file name', () => {
    expect(figureId('figures/Glow_Curve 2.png')).toBe('fig-glow-curve-2');
  });

  it('inserts a caption, escaping brackets, with the path relative to the document', () => {
    expect(figureMarkdown('figures/glow.png', 'Glow [raw] curve\nfit')).toBe('![Glow \\[raw\\] curve fit](figures/glow.png){#fig-glow}');
    expect(figureMarkdown('figures/glow.png', '', 'paper/index.qmd')).toBe('![](../figures/glow.png){#fig-glow}');
  });

  it('builds the drop-to-insert text with an empty caption', () => {
    expect(dropInsertion('figures/a-b.png', 'index.qmd')).toBe('![](figures/a-b.png){#fig-a-b}');
  });

  it('computes relative paths', () => {
    expect(relativePath('index.qmd', 'figures/a.png')).toBe('figures/a.png');
    expect(relativePath('paper/sections/a.qmd', 'paper/figures/a.png')).toBe('../figures/a.png');
  });
});

describe('binary changes', () => {
  it('encodes bytes as base64 and marks the change', () => {
    expect(bytesToBase64(new Uint8Array([0, 1, 2, 250, 255]))).toBe('AAEC+v8=');
    expect(uploadChange({ path: 'figures/a.png', bytes: new Uint8Array([1, 2, 3]) })).toEqual({
      path: 'figures/a.png',
      content: 'AQID',
      encoding: 'base64',
    });
  });
});

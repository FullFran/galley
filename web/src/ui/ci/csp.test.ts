import { describe, expect, it } from 'vitest';
import { APP_CSP } from '../../../vite.config';

// The production CSP of the app page. The compiled PDF and draft PDF views show
// PDFs from blob: URLs in an iframe, and BusyTeX compiles the draft PDF with
// WebAssembly in a worker; nothing else changes.
const PREVIOUS = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://api.github.com https://galley-api.fullfran.com https://*.blob.core.windows.net https://api.crossref.org",
  "frame-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

describe('app CSP', () => {
  it("allows blob: frames and WebAssembly compilation, and keeps object-src 'none'", () => {
    const directives = APP_CSP.split('; ');
    expect(directives).toContain("frame-src 'self' blob:");
    expect(directives).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(directives).toContain("object-src 'none'");
  });

  it('changes no other directive', () => {
    const expected = PREVIOUS.map((d) => {
      if (d === "frame-src 'self'") return "frame-src 'self' blob:";
      if (d === "script-src 'self'") return "script-src 'self' 'wasm-unsafe-eval'";
      return d;
    });
    expect(APP_CSP.split('; ')).toEqual(expected);
  });
});

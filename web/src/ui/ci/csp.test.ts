import { describe, expect, it } from 'vitest';
import { APP_CSP } from '../../../vite.config';

// The production CSP of the app page. The compiled PDF view shows the PDF from
// a blob: URL in an iframe, so frame-src allows blob:; nothing else changes.
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
  it("allows blob: frames for the compiled PDF and keeps object-src 'none'", () => {
    const directives = APP_CSP.split('; ');
    expect(directives).toContain("frame-src 'self' blob:");
    expect(directives).toContain("object-src 'none'");
  });

  it('changes no other directive', () => {
    const expected = PREVIOUS.map((d) => (d === "frame-src 'self'" ? "frame-src 'self' blob:" : d));
    expect(APP_CSP.split('; ')).toEqual(expected);
  });
});

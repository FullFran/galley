import { defineConfig, type Plugin } from 'vite';

// Strict CSP for the production build only. The Vite dev server injects inline
// scripts and styles for HMR, which this policy would block.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api.github.com https://galley-api.fullfran.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function productionCsp(): Plugin {
  return {
    name: 'galley-production-csp',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [productionCsp()],
  build: {
    // Keep all assets as files so the CSP never needs 'unsafe-inline' or data: scripts.
    assetsInlineLimit: 0,
  },
});

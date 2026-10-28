import { defineConfig, type Connect, type Plugin } from 'vite';

// Strict CSPs for the production build only. The Vite dev server injects inline
// scripts and styles for HMR, which these policies would block.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // blob: for the upload preview (an <img> of the chosen file, created in this page).
  "img-src 'self' data: blob:",
  // *.blob.core.windows.net: GitHub Actions artifact zips. api.github.com answers
  // the download with a redirect to a short-lived signed URL there (for example
  // productionresultssaNN.blob.core.windows.net, CORS `*`); CSP host wildcards
  // only cover a whole leftmost label. github/client.ts allows that redirect
  // for the artifact zip endpoint alone.
  "connect-src 'self' https://api.github.com https://galley-api.fullfran.com https://*.blob.core.windows.net",
  "frame-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// The preview page renders untrusted repository content inside
// <iframe sandbox="allow-scripts">. It may load only its own script, styles
// and fonts; figures arrive as bytes over postMessage and are shown from
// blob: URLs. No fetch, no remote images, no frames, no forms.
// In the opaque-origin frame Chromium matches 'self' against the URL origin.
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src blob:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function productionCsp(): Plugin {
  return {
    name: 'galley-production-csp',
    apply: 'build',
    transformIndexHtml(_html, ctx) {
      const content = ctx.path.endsWith('/preview.html') ? PREVIEW_CSP : APP_CSP;
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

// The sandboxed preview frame has an opaque origin, so its module scripts and
// fonts are CORS requests with `Origin: null`. GitHub Pages answers every
// request with `Access-Control-Allow-Origin: *`. The local dev and preview
// servers keep Vite's localhost-only CORS and answer the null origin only for
// the files the frame loads, so a sandboxed frame on another website cannot
// read the rest of the dev server (sources, env files).
const FRAME_PATHS = {
  dev: [
    /^\/preview\.html$/,
    /^\/@vite\/(client|env)$/,
    /^\/node_modules\/vite\/dist\/client\//,
    /^\/src\/preview\//,
    /^\/node_modules\/\.vite\/deps\//,
    /^\/node_modules\/katex\/dist\//,
  ],
  preview: [/^\/preview\.html$/, /^\/assets\/(preview|protocol|cmu-serif|KaTeX)[\w.-]*$/],
};

interface Req {
  headers: { origin?: string };
  url?: string;
}
interface Res {
  setHeader(name: string, value: string): unknown;
}

// Typed structurally: this config is checked without Node's type definitions.
function allowNullOrigin(paths: RegExp[]): Connect.NextHandleFunction {
  return (rawReq, rawRes, next) => {
    const req = rawReq as unknown as Req;
    const res = rawRes as unknown as Res;
    if (req.headers.origin === 'null') {
      // The URL parser resolves dot segments (also %2e), so the prefix checks hold.
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (paths.some((p) => p.test(path))) {
        res.setHeader('Access-Control-Allow-Origin', 'null');
        res.setHeader('Vary', 'Origin');
      }
    }
    next();
  };
}

function previewFrameCors(): Plugin {
  return {
    name: 'galley-preview-frame-cors',
    configureServer(server) {
      server.middlewares.use(allowNullOrigin(FRAME_PATHS.dev));
    },
    configurePreviewServer(server) {
      server.middlewares.use(allowNullOrigin(FRAME_PATHS.preview));
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [productionCsp(), previewFrameCors()],
  build: {
    // Keep all assets as files so the CSP never needs 'unsafe-inline' or data: scripts.
    assetsInlineLimit: 0,
    // The preview renderer (KaTeX, citeproc-js, markdown-it) is the render worker,
    // about 850 kB, which only loads with the preview.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: { main: 'index.html', preview: 'preview.html' },
    },
  },
});

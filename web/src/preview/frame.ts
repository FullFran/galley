import DOMPurify, { type Config } from 'dompurify';
import 'katex/dist/katex.min.css';
import './preview.css';
import { FRAME_READY, parseRenderMessage, type ReadyMessage } from './protocol';

// Runs inside <iframe sandbox="allow-scripts">: the document has an opaque
// origin, so it cannot read galley's storage, cookies or DOM, and its CSP
// blocks all network access. It accepts render messages from the parent
// galley window only, sanitizes the HTML again (the renderer already escapes
// all source markup), and shows figures from blob: URLs it creates itself.

const page = document.getElementById('page');
// The document origin is opaque ("null"), but location still carries the URL
// origin, which is galley's own origin: the only valid parent.
const galleyOrigin = location.origin;
// Set by the renderer instead of `style`: the CSP (`style-src 'self'`) refuses
// style attributes parsed from markup and reports each one, so styles (KaTeX
// positions glyphs with them) are applied through the CSSOM, which CSP allows.
const CSS_ATTR = 'data-galley-css';
let lastSeq = -1;
let urls: string[] = [];

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    if (!/^(#|https?:|mailto:)/i.test(href)) node.removeAttribute('href');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const PURIFY: Config & { RETURN_DOM_FRAGMENT: true } = {
  RETURN_DOM_FRAGMENT: true,
  FORBID_TAGS: [
    'style', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'frame',
    'object', 'embed', 'template', 'use', 'foreignObject', 'animate', 'set', 'animateMotion', 'animateTransform',
  ],
  FORBID_ATTR: ['style', 'src', 'srcset', 'action', 'formaction', 'xlink:href', 'ping', 'target'],
};

function show(html: string, assets: { id: string; type: string; bytes: Uint8Array }[]) {
  if (!page) return;
  const fragment = DOMPurify.sanitize(html, PURIFY);
  const next = new Map<string, string>();
  for (const a of assets) {
    next.set(a.id, URL.createObjectURL(new Blob([a.bytes.slice()], { type: a.type })));
  }
  for (const img of fragment.querySelectorAll<HTMLImageElement>('img[data-galley-asset]')) {
    const url = next.get(img.dataset.galleyAsset ?? '');
    if (url) img.src = url;
  }
  page.replaceChildren(fragment);
  for (const el of page.querySelectorAll<HTMLElement>(`[${CSS_ATTR}]`)) {
    el.style.cssText = el.getAttribute(CSS_ATTR) ?? '';
    el.removeAttribute(CSS_ATTR);
  }
  for (const url of urls) URL.revokeObjectURL(url);
  urls = [...next.values()];
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== galleyOrigin) return;
  const message = parseRenderMessage(event.data);
  if (!message || message.seq <= lastSeq) return;
  lastSeq = message.seq;
  show(message.html, message.assets);
});

// Links never navigate the frame away from this page: only in-document
// anchors (cross-references, footnotes) work.
const blockNavigation = (event: MouseEvent) => {
  const link = (event.target as Element | null)?.closest?.('a');
  if (!link) return;
  const href = link.getAttribute('href') ?? '';
  if (href.startsWith('#') && event.type === 'click') return;
  event.preventDefault();
};
document.addEventListener('click', blockNavigation, true);
document.addEventListener('auxclick', blockNavigation, true);

// Like a PDF viewer's "fit width": a frame narrower than the A4 sheet scales
// the sheet down so lines break about where they do in the PDF. Phones get the
// reflowed single column from preview.css instead.
const SHEET_PX = (210 / 25.4) * 96 + 24;
const fitWidth = () => {
  const width = window.innerWidth;
  document.body.style.zoom = width > 480 && width < SHEET_PX ? String(width / SHEET_PX) : '';
};
window.addEventListener('resize', fitWidth);
fitWidth();

if (window.parent !== window) {
  const ready: ReadyMessage = { type: FRAME_READY };
  window.parent.postMessage(ready, galleyOrigin);
}

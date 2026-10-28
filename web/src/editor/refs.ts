import { dirname, resolvePath } from '../render/source';

// Pandoc citation syntax shared by autocomplete, warnings and go to definition.
// A key starts with a letter, digit or `_` and may hold `:.#$%&-+?<>~/`
// inside; trailing punctuation belongs to the sentence. `@` right after a
// word character (an e-mail address), a dot or a slash is not a citation.

export const CITE = /(?<![\w@./\\])@([\w][\w:.#$%&\-+?<>~/]*)/g;
export const CITE_BEFORE_CURSOR = /(?<![\w@./\\])@([\w:.#$%&\-+?<>~/]*)$/;

export const citeKey = (raw: string) => raw.replace(/[:.#$%&\-+?<>~/]+$/, '');
export const isCrossref = (key: string) => /^(fig|tbl|eq|sec)-/.test(key);

export const INCLUDE_SPAN = /\{\{<\s*include\s+["']?([^\s"'>]+)["']?\s*>\}\}/g;
export const IMAGE_SPAN = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf'];
export const isImage = (path: string) => IMAGE_EXTENSIONS.includes(/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '');

/** Resolves a figure path like the preview: from the entry document's folder, then the root; the extension may be left out. */
export function resolveImage(raw: string, entry: string | undefined, known: ReadonlySet<string>): string | undefined {
  let decoded = raw;
  try {
    decoded = decodeURI(raw);
  } catch {
    // keep the raw value
  }
  for (const base of [resolvePath(dirname(entry ?? ''), decoded), resolvePath('', decoded)]) {
    if (base === undefined) continue;
    if (isImage(base) && known.has(base)) return base;
    for (const ext of IMAGE_EXTENSIONS) if (known.has(`${base}.${ext}`)) return `${base}.${ext}`;
  }
  return undefined;
}

/**
 * The same text with front matter, fenced code and inline code blanked out
 * (same length, line breaks kept), so offsets still match the original.
 */
export function maskCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const lines = text.split('\n');
  let fence: string | undefined;
  let front = lines[0]?.trim() === '---';
  return lines
    .map((line, i) => {
      if (front) {
        if (i > 0 && /^(---|\.\.\.)\s*$/.test(line)) front = false;
        return blank(line);
      }
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
        return blank(line);
      }
      if (marker) {
        fence = marker;
        return blank(line);
      }
      return line.replace(/(`+)[^`]*?\1/g, blank);
    })
    .join('\n');
}

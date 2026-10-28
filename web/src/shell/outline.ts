// The outline of a Quarto or Markdown document: its ATX headings and its
// `{{< include >}}` shortcodes, with 1-based line numbers for jumping there.
// Line-by-line scanning with plain string operations, no backtracking regex,
// so a hostile file cannot make it slow.

export type OutlineItem =
  | { kind: 'heading'; level: number; title: string; line: number; id?: string }
  | { kind: 'include'; path: string; line: number };

const INCLUDE_OPEN = '{{<';
const INCLUDE_CLOSE = '>}}';

function fence(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (line.length - trimmed.length > 3) return undefined;
  const marker = trimmed.startsWith('```') ? '`' : trimmed.startsWith('~~~') ? '~' : undefined;
  if (!marker) return undefined;
  let n = 0;
  while (trimmed[n] === marker) n += 1;
  return marker.repeat(n);
}

function heading(line: string, number: number): OutlineItem | undefined {
  let level = 0;
  while (line[level] === '#') level += 1;
  if (level === 0 || level > 6) return undefined;
  const after = line[level];
  if (after !== ' ' && after !== '\t') return undefined;
  let title = line.slice(level).trim();
  let id: string | undefined;
  if (title.endsWith('}')) {
    const open = title.lastIndexOf('{');
    if (open >= 0) {
      for (const token of title.slice(open + 1, -1).split(/\s+/)) {
        if (token.startsWith('#') && token.length > 1) id = token.slice(1);
      }
      title = title.slice(0, open).trim();
    }
  }
  // Optional closing sequence: "## Title ##".
  let end = title.length;
  while (end > 0 && title[end - 1] === '#') end -= 1;
  if (end < title.length && (end === 0 || title[end - 1] === ' ' || title[end - 1] === '\t')) title = title.slice(0, end).trim();
  if (!title) return undefined;
  return id ? { kind: 'heading', level, title, line: number, id } : { kind: 'heading', level, title, line: number };
}

function include(line: string, number: number): OutlineItem | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(INCLUDE_OPEN) || !trimmed.endsWith(INCLUDE_CLOSE)) return undefined;
  const inner = trimmed.slice(INCLUDE_OPEN.length, -INCLUDE_CLOSE.length).trim();
  if (!inner.startsWith('include ') && !inner.startsWith('include\t')) return undefined;
  let path = inner.slice('include'.length).trim();
  if (path.length >= 2 && (path[0] === '"' || path[0] === "'") && path.endsWith(path[0])) path = path.slice(1, -1);
  return path ? { kind: 'include', path, line: number } : undefined;
}

export function extractOutline(text: string): OutlineItem[] {
  const lines = text.split('\n');
  const items: OutlineItem[] = [];
  let i = 0;
  if (lines[0]?.trimEnd() === '---') {
    const close = lines.findIndex((l, n) => n > 0 && (l.trimEnd() === '---' || l.trimEnd() === '...'));
    if (close > 0) i = close + 1;
  }
  let openFence: string | undefined;
  let inComment = false;
  for (; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    const number = i + 1;
    if (openFence) {
      const f = fence(line);
      if (f && f[0] === openFence[0] && f.length >= openFence.length && line.trim() === f) openFence = undefined;
      continue;
    }
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    const f = fence(line);
    if (f) {
      openFence = f;
      continue;
    }
    const comment = line.indexOf('<!--');
    if (comment >= 0 && !line.includes('-->', comment + 4)) {
      inComment = true;
      continue;
    }
    const item = heading(line, number) ?? include(line, number);
    if (item) items.push(item);
  }
  return items;
}

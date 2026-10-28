import { escapeHtml } from './markdown';

// The elsarticle title block: title, authors with affiliation marks, the
// affiliations, and the abstract and keywords between two rules. Authors and
// affiliations follow Quarto's normalized schema; strings and short forms are
// accepted too.

type Meta = Record<string, unknown>;

interface Affiliation {
  id?: string;
  text: string;
}

const isRecord = (v: unknown): v is Meta => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);

function personName(v: unknown): string {
  if (!isRecord(v)) return str(v) ?? '';
  const literal = str(v.literal);
  if (literal) return literal;
  return [str(v.given), str(v['dropping-particle']), str(v['non-dropping-particle']), str(v.family)].filter(Boolean).join(' ');
}

function affiliationText(v: Meta): string {
  return ['department', 'name', 'address', 'city', 'region', 'state', 'postal-code', 'country']
    .map((k) => str(v[k]))
    .filter(Boolean)
    .join(', ');
}

function collect(front: Meta) {
  const affiliations: Affiliation[] = [];
  const find = (ref: unknown): number => {
    if (isRecord(ref) && str(ref.ref)) return affiliations.findIndex((a) => a.id === str(ref.ref));
    const text = isRecord(ref) ? affiliationText(ref) : (str(ref) ?? '');
    const id = isRecord(ref) ? str(ref.id) : undefined;
    let i = affiliations.findIndex((a) => (id && a.id === id) || a.text === text);
    if (i < 0 && text) i = affiliations.push({ id, text }) - 1;
    return i;
  };
  for (const a of list(front.affiliations)) {
    if (isRecord(a)) affiliations.push({ id: str(a.id), text: affiliationText(a) });
    else if (str(a)) affiliations.push({ text: str(a) ?? '' });
  }
  const authors = list(front.author ?? front.authors).map((a) => {
    if (!isRecord(a)) return { name: str(a) ?? '', marks: [] as number[] };
    const refs = list(a.affiliations ?? a.affiliation);
    return { name: personName(a.name ?? a), marks: refs.map(find).filter((i) => i >= 0) };
  });
  return { authors, affiliations };
}

const mark = (i: number) => String.fromCharCode(97 + (i % 26));

export function renderTitleBlock(front: Meta, inline: (s: string) => string, abstractHtml: string): string {
  const title = str(front.title);
  const subtitle = str(front.subtitle);
  const { authors, affiliations } = collect(front);
  const many = affiliations.length > 1 || authors.some((a) => a.marks.length > 0);
  const keywords = list(front.keywords).map(str).filter(Boolean) as string[];
  if (!title && authors.length === 0 && !abstractHtml && keywords.length === 0) return '';

  let out = '<header class="title-block">\n';
  if (title) out += `<h1 class="title">${inline(title)}</h1>\n`;
  if (subtitle) out += `<p class="subtitle">${inline(subtitle)}</p>\n`;
  if (authors.length) {
    const names = authors.map((a) => {
      const sup = many && a.marks.length ? `<sup>${a.marks.map(mark).join(',')}</sup>` : '';
      return `<span class="author">${escapeHtml(a.name)}${sup}</span>`;
    });
    out += `<p class="authors">${names.join(', ')}</p>\n`;
  }
  if (affiliations.length) {
    out += '<div class="affiliations">\n';
    affiliations.forEach((a, i) => {
      const sup = many ? `<sup>${mark(i)}</sup>` : '';
      out += `<p class="affiliation">${sup}${escapeHtml(a.text)}</p>\n`;
    });
    out += '</div>\n';
  }
  out += '</header>\n';
  if (abstractHtml || keywords.length) {
    out += '<section class="frontmatter-box">\n';
    if (abstractHtml) out += `<section class="abstract">\n<h2 class="abstract-title">Abstract</h2>\n${abstractHtml}</section>\n`;
    if (keywords.length) out += `<p class="keywords"><em>Keywords:</em> ${keywords.map(escapeHtml).join(', ')}</p>\n`;
    out += '</section>\n';
  }
  return out;
}

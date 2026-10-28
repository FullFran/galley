// Slugs for new file names and ids: NFKD transliteration, then only a-z,
// 0-9 and single hyphens, at most 40 characters (cut on a word boundary when
// that keeps at least half). No regular expression here backtracks.

export const MAX_SLUG = 40;

// Letters NFKD does not decompose into ASCII.
const SPECIAL: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  ø: 'o',
  Ø: 'o',
  đ: 'd',
  Đ: 'd',
  ł: 'l',
  Ł: 'l',
  þ: 'th',
  Þ: 'th',
  ð: 'd',
  Ð: 'd',
  ı: 'i',
};

export function slugify(title: string, max = MAX_SLUG): string {
  const ascii = [...title.normalize('NFKD')]
    .map((c) => SPECIAL[c] ?? c)
    .join('')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
  const slug = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const hyphen = cut.lastIndexOf('-');
  return (hyphen >= max / 2 ? cut.slice(0, hyphen) : cut).replace(/-+$/, '');
}

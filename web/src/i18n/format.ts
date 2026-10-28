// Dates and times in the active language, through Intl. `lang` is the
// catalog's `meta.lang`.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parse(iso: string): number | undefined {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** "28 oct 2026" / "Oct 28, 2026"; '' for an invalid date. */
export function formatDay(iso: string, lang: string): string {
  const ms = parse(iso);
  return ms === undefined ? '' : new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(ms);
}

/** Date and time, for comments; '' for an invalid date. */
export function formatDateTime(iso: string, lang: string): string {
  const ms = parse(iso);
  return ms === undefined ? '' : new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
}

/** "14:05:09", for the last compile. */
export function formatClock(ms: number, lang: string): string {
  return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms);
}

/**
 * "3 hours ago" within the last week, else the date. '' for an invalid date.
 * Future times (clock skew) read as "now".
 */
export function formatUpdated(iso: string, lang: string, now = Date.now()): string {
  const ms = parse(iso);
  if (ms === undefined) return '';
  const ago = Math.max(0, now - ms);
  if (ago >= 7 * DAY) return formatDay(iso, lang);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (ago < HOUR) return rtf.format(-Math.round(ago / MINUTE), 'minute');
  if (ago < DAY) return rtf.format(-Math.round(ago / HOUR), 'hour');
  return rtf.format(-Math.round(ago / DAY), 'day');
}

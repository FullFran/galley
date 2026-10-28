import type { Messages } from '../i18n/en';

/** A pending change described for people, in the save summary and the commit message. */
export type ChangeSummary =
  | { kind: 'section'; title: string; after?: string }
  | { kind: 'subsection'; title: string; parent: string }
  | { kind: 'upload'; name: string; replace: boolean };

export function describeChange(change: ChangeSummary, t: Messages): string {
  const m = t.authoring;
  switch (change.kind) {
    case 'section':
      return change.after === undefined ? m.summarySectionStart(change.title) : m.summarySectionAfter(change.title, change.after);
    case 'subsection':
      return m.summarySubsection(change.title, change.parent);
    case 'upload':
      return change.replace ? m.summaryReplace(change.name) : m.summaryUpload(change.name);
  }
}

/** The commit message when the person wrote no note: the summaries, shortened. */
export function summaryMessage(changes: ChangeSummary[], t: Messages, max = 120): string | undefined {
  if (changes.length === 0) return undefined;
  const text = changes.map((c) => describeChange(c, t)).join('; ');
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

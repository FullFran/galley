import { en, type Messages } from '../i18n';

// Small decisions about the editing session that the workspace shows.

const DOCUMENT = /\.(qmd|md|markdown)$/i;

/**
 * The document to open when a repository opens: the `.galley.yml` entry when
 * the person can see it, else `index.qmd`, else the first top-level document,
 * else the first document anywhere.
 */
export function mainDocument(visible: string[], entry?: string): string | undefined {
  if (entry && visible.includes(entry)) return entry;
  for (const name of ['index.qmd', 'index.md']) if (visible.includes(name)) return name;
  const docs = visible.filter((p) => DOCUMENT.test(p)).sort((a, b) => a.localeCompare(b));
  const prefer = (p: string) => (p.endsWith('.qmd') ? 0 : 1);
  const top = docs.filter((p) => !p.includes('/')).sort((a, b) => prefer(a) - prefer(b));
  return top[0] ?? docs.sort((a, b) => prefer(a) - prefer(b))[0];
}

/** The save state shown in the header. */
export function saveStateLabel(dirtyCount: number, saving: boolean, t: Messages = en): string {
  const m = t.save;
  if (saving) return m.saving;
  if (dirtyCount === 0) return m.allSaved;
  return m.unsaved(dirtyCount);
}

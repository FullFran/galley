import { matchGlob } from './glob';
import { CONFIG_PATH, parseConfig, serializeConfig, type ConfigProblem, type GalleyConfig } from './schema';

// Pure helpers behind the setup wizard and the settings screen.

const DOCUMENT = /\.(qmd|md|markdown|bib|txt)$/i;
const hidden = (path: string) => path.split('/').some((seg) => seg.startsWith('.'));

/** Files offered as checkboxes: the paper's own documents. */
export function candidateFiles(files: readonly string[]): string[] {
  return files.filter((f) => f !== CONFIG_PATH && !hidden(f) && DOCUMENT.test(f));
}

/** Another pattern in the list that already includes `path`, if any. */
export function coveredBy(path: string, editable: readonly string[]): string | undefined {
  return editable.find((p) => p !== path && matchGlob(p, path));
}

export function togglePattern(draft: GalleyConfig, pattern: string, on: boolean): GalleyConfig {
  if (on) return draft.editable.includes(pattern) ? draft : { ...draft, editable: [...draft.editable, pattern] };
  return { ...draft, editable: draft.editable.filter((p) => p !== pattern) };
}

export function parseAccept(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/** The file a draft would produce and the problems the saved file would have. */
export function checkDraft(draft: GalleyConfig): { text: string; problems: ConfigProblem[] } {
  const text = serializeConfig(draft);
  return { text, problems: parseConfig(text).problems };
}

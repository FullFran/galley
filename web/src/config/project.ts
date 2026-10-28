import { matchAny } from './glob';
import type { ConfigProblem, GalleyConfig } from './schema';

// Kept free of the YAML parser so the editor's first load stays small; parsing
// lives in `load.ts` and `schema.ts`, which are loaded on demand.

export const CONFIG_PATH = '.galley.yml';

/** The project configuration as found at the working head. */
export type ProjectConfig =
  | { kind: 'missing' }
  | { kind: 'valid'; config: GalleyConfig; problems: ConfigProblem[] }
  | { kind: 'invalid'; problems: ConfigProblem[] };

// Shown to co-authors when the project is not set up (or its file is invalid):
// the paper's own text files, never configuration, scripts or hidden files.
const FALLBACK = /\.(qmd|md|bib)$/i;

const hidden = (path: string) => path.split('/').some((seg) => seg.startsWith('.'));

/**
 * The files galley lists and opens for editing. Admins see every file. Others
 * see the `editable` matches, or the paper's documents when there is no valid
 * configuration. `.galley.yml` and hidden folders are never shown to them.
 * This only narrows galley's own view: GitHub permissions are unchanged.
 */
export function visibleFiles(files: readonly string[], project: ProjectConfig, admin: boolean): string[] {
  if (admin) return [...files];
  const shown =
    project.kind === 'valid'
      ? (path: string) => matchAny(project.config.editable, path)
      : (path: string) => FALLBACK.test(path) && !hidden(path);
  return files.filter((path) => path !== CONFIG_PATH && !path.startsWith('.github/') && shown(path));
}

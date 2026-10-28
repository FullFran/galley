import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { EditorMode } from '../shell/prefs';

// The browser's own spellchecker on the editor text, in Writing mode only
// (code, YAML and BibTeX would be all red). Nothing leaves the browser that
// would not anyway: the check is the browser's (some browsers offer an
// optional online checker in their own settings). The language is the
// paper's `lang` (`_quarto.yml`, else the main file's front matter), else the
// interface language.

const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function topLevelLang(yaml: string): string | undefined {
  const m = /^lang:[ \t]*(["']?)([^"'\r\n#]*?)\1[ \t]*(?:#.*)?\r?$/m.exec(yaml);
  const value = m?.[2]?.trim();
  return value && TAG.test(value) ? value : undefined;
}

function frontMatter(text: string): string | undefined {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  const close = lines.findIndex((l, n) => n > 0 && /^(---|\.\.\.)\s*$/.test(l));
  return close > 0 ? lines.slice(1, close).join('\n') : undefined;
}

/** The paper's language: `lang` of `_quarto.yml`, else of the main file's front matter. */
export function paperLanguage(quartoYml: string | undefined, mainText: string | undefined): string | undefined {
  const fromProject = quartoYml === undefined ? undefined : topLevelLang(quartoYml);
  if (fromProject) return fromProject;
  const fm = mainText === undefined ? undefined : frontMatter(mainText);
  return fm === undefined ? undefined : topLevelLang(fm);
}

export function spellcheckAttributes(mode: EditorMode, enabled: boolean, lang: string): Record<string, string> {
  return mode === 'writing' && enabled ? { spellcheck: 'true', lang } : { spellcheck: 'false' };
}

export function spellcheckExtension(mode: EditorMode, enabled: boolean, lang: string): Extension {
  return EditorView.contentAttributes.of(spellcheckAttributes(mode, enabled, lang));
}

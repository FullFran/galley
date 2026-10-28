import { useEffect, useMemo, useState } from 'preact/hooks';
import type { RepoGateway, Repository, WorkingState } from '../domain';
import type { WordLimits } from '../config/schema';
import { resolveInclude, type ProjectIndex } from '../editor/projectIndex';
import { useT } from '../i18n';
import type { OutlineItem } from '../shell/outline';
import { paperLanguage } from '../writing/spellcheck';
import { wordStatus } from '../writing/words';

const QUARTO = '_quarto.yml';

export interface WritingAidsOptions {
  gateway: RepoGateway;
  repo: Repository;
  working?: WorkingState;
  index?: ProjectIndex;
  limits?: WordLimits;
  /** Text of the main document (its front matter may hold `lang`). */
  mainText?: string;
  openPath?: string;
}

/**
 * Word counts for the header and the Outline (from the project index, built
 * in its worker) and the language for the browser spellcheck.
 */
export function useWritingAids({ gateway, repo, working, index, limits, mainText, openPath }: WritingAidsOptions) {
  const t = useT();
  const w = t.writing;
  const [quarto, setQuarto] = useState<string>();
  const hasQuarto = working?.files.includes(QUARTO) ?? false;
  const head = working?.headSha;
  useEffect(() => {
    setQuarto(undefined);
    if (!hasQuarto || !head) return;
    let active = true;
    gateway.readFile(repo, QUARTO, head).then(
      (text) => active && setQuarto(text),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [gateway, repo, head, hasQuarto]);

  const lang = useMemo(() => paperLanguage(quarto, mainText) ?? t.meta.lang, [quarto, mainText, t.meta.lang]);
  const number = useMemo(() => new Intl.NumberFormat(t.meta.lang), [t.meta.lang]);
  const words = index?.words;

  let status = null;
  if (words && words.total > 0) {
    const state = wordStatus(words, limits);
    const total = limits?.words ? w.wordsOf(number.format(words.total), number.format(limits.words)) : w.words(words.total, number.format(words.total));
    const abstract =
      words.abstract > 0 || limits?.abstractWords
        ? limits?.abstractWords
          ? w.abstractOf(number.format(words.abstract), number.format(limits.abstractWords))
          : w.abstract(words.abstract, number.format(words.abstract))
        : undefined;
    const details = [
      `${total}${state.totalOver ? ` (${w.overLimit})` : ''}`,
      abstract ? `${abstract}${state.abstractOver ? ` (${w.overLimit})` : ''}` : undefined,
      w.countRule,
    ].filter(Boolean);
    status = (
      <span class="word-count" data-over={state.over ? 'true' : undefined} title={details.join('\n')} aria-label={details.slice(0, 2).join('. ')}>
        {w.words(words.total, number.format(words.total))}
      </span>
    );
  }

  const known = useMemo(() => new Set(index?.paths ?? []), [index]);
  const outlineWords = (item: OutlineItem): string | undefined => {
    if (!words || !openPath) return undefined;
    let n: number | undefined;
    if (item.kind === 'heading') n = words.files[openPath]?.sections.find((s) => s.line === item.line)?.words;
    else {
      const target = resolveInclude(openPath, item.path, known);
      n = target ? words.files[target]?.total : undefined;
    }
    return n === undefined ? undefined : w.sectionWords(n, number.format(n));
  };

  return { lang, status, outlineWords };
}

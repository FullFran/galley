import type { ComponentChildren } from 'preact';
import { useT } from '../../i18n';
import type { ContentsTab } from '../../shell/prefs';

export interface ContentsProps {
  tab: ContentsTab;
  onTab: (tab: ContentsTab) => void;
  outline: ComponentChildren;
  files: ComponentChildren;
  /** Tooltip of the Files tab: why co-authors see fewer files. */
  filesHint?: string;
}

const TABS: ContentsTab[] = ['outline', 'files'];

/**
 * Outline | Files over one scrolling tree, instead of two stacked trees that
 * listed the main file twice. A radio group: arrow keys switch.
 */
export function Contents({ tab, onTab, outline, files, filesHint }: ContentsProps) {
  const t = useT();
  const move = (e: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = tab === 'outline' ? 'files' : 'outline';
    onTab(next);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus();
  };
  return (
    <div class="contents">
      <div class="segmented contents-tabs" role="radiogroup" aria-label={t.nav.contents} onKeyDown={move}>
        {TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            data-value={value}
            aria-checked={tab === value}
            aria-controls="contents-panel"
            tabIndex={tab === value ? 0 : -1}
            title={value === 'files' ? filesHint : undefined}
            onClick={() => onTab(value)}
          >
            {value === 'outline' ? t.nav.outline : t.nav.files}
          </button>
        ))}
      </div>
      <div id="contents-panel" class="contents-panel">
        {tab === 'outline' ? outline : files}
      </div>
    </div>
  );
}

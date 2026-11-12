import { useT } from '../i18n';
import { formatClock } from '../i18n/format';
import type { PreviewMode } from '../shell/prefs';
import './editing/toolbar.css';

export interface CompileBarProps {
  compiling: boolean;
  /** Edits made since the last compile. */
  stale: boolean;
  lastCompiledAt?: number;
  auto: boolean;
  onRecompile: () => void;
  onAuto: (auto: boolean) => void;
  /** Print / save as PDF (an unofficial copy); not offered without it. */
  onPrint?: () => void;
  mode?: PreviewMode;
  onMode?: (mode: PreviewMode) => void;
}

/**
 * Above the preview: Recompile (Ctrl/Cmd+Enter), the auto-compile switch and,
 * only while the preview is behind the editor, an "Out of date" badge. The
 * last compile time sits in the button's tooltip.
 */
export function CompileBar({ compiling, stale, lastCompiledAt, auto, onRecompile, onAuto, onPrint, mode = 'html', onMode }: CompileBarProps) {
  const t = useT();
  const m = t.compile;
  const tooltip = lastCompiledAt !== undefined ? `${m.shortcut} · ${m.compiledAt(formatClock(lastCompiledAt, t.meta.lang))}` : m.shortcut;
  return (
    <div class="compile-bar" data-tour="compile">
      <button
        type="button"
        class="secondary"
        onClick={onRecompile}
        disabled={compiling}
        title={tooltip}
        aria-keyshortcuts="Control+Enter Meta+Enter"
      >
        {compiling ? m.compiling : m.recompile}
      </button>
      <label class="switch-row compile-auto">
        <input type="checkbox" role="switch" class="switch" checked={auto} onChange={(e) => onAuto(e.currentTarget.checked)} />
        <span>{m.auto}</span>
      </label>
      <span class="compile-state" aria-live="polite">
        {!compiling && stale && (
          <span class="chip chip-warn" title={m.stale}>
            {m.outOfDate}
          </span>
        )}
      </span>
      {onMode && (
        <div class="compile-modes" role="tablist" aria-label={t.preview.frameTitle}>
          <button
            type="button"
            role="tab"
            class={mode === 'html' ? 'chip chip-active' : 'chip'}
            aria-selected={mode === 'html'}
            onClick={() => onMode('html')}
            title={t.draftPdf.htmlTab}
          >
            {t.draftPdf.htmlTab}
          </button>
          <button
            type="button"
            role="tab"
            class={mode === 'pdf' ? 'chip chip-active' : 'chip'}
            aria-selected={mode === 'pdf'}
            onClick={() => onMode('pdf')}
            title={t.draftPdf.tab}
          >
            {t.draftPdf.tab}
          </button>
        </div>
      )}
      {onPrint && (
        <button type="button" class="secondary compile-print" onClick={onPrint} disabled={compiling} title={t.print.hint}>
          {t.print.action}
        </button>
      )}
    </div>
  );
}

import { useT } from '../i18n';
import { formatClock } from '../i18n/format';

export interface CompileBarProps {
  compiling: boolean;
  /** Edits made since the last compile. */
  stale: boolean;
  lastCompiledAt?: number;
  auto: boolean;
  onRecompile: () => void;
  onAuto: (auto: boolean) => void;
}

/** Recompile button (Ctrl/Cmd+Enter), auto-compile toggle and compile state, above the preview. */
export function CompileBar({ compiling, stale, lastCompiledAt, auto, onRecompile, onAuto }: CompileBarProps) {
  const t = useT();
  const m = t.compile;
  return (
    <div class="compile-bar" data-tour="compile">
      <button
        type="button"
        class="secondary"
        onClick={onRecompile}
        disabled={compiling}
        title={m.shortcut}
        aria-keyshortcuts="Control+Enter Meta+Enter"
      >
        {compiling ? m.compiling : m.recompile}
      </button>
      <label class="compile-auto">
        <input type="checkbox" checked={auto} onChange={(e) => onAuto(e.currentTarget.checked)} /> {m.auto}
      </label>
      <span class="muted compile-state" aria-live="polite">
        {compiling
          ? m.compiling
          : stale
            ? m.stale
            : lastCompiledAt !== undefined
              ? m.compiledAt(formatClock(lastCompiledAt, t.meta.lang))
              : ''}
      </span>
    </div>
  );
}

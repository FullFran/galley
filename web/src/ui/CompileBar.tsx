export interface CompileBarProps {
  compiling: boolean;
  /** Edits made since the last compile. */
  stale: boolean;
  lastCompiledAt?: number;
  auto: boolean;
  onRecompile: () => void;
  onAuto: (auto: boolean) => void;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Recompile button (Ctrl/Cmd+Enter), auto-compile toggle and compile state, above the preview. */
export function CompileBar({ compiling, stale, lastCompiledAt, auto, onRecompile, onAuto }: CompileBarProps) {
  return (
    <div class="compile-bar">
      <button
        type="button"
        class="primary"
        onClick={onRecompile}
        disabled={compiling}
        title="Recompile (Ctrl+Enter or Cmd+Enter)"
        aria-keyshortcuts="Control+Enter Meta+Enter"
      >
        {compiling ? 'Compiling…' : 'Recompile'}
      </button>
      <label class="compile-auto">
        <input type="checkbox" checked={auto} onChange={(e) => onAuto(e.currentTarget.checked)} /> Auto-compile
      </label>
      <span class="muted compile-state" aria-live="polite">
        {compiling
          ? 'Compiling…'
          : stale
            ? 'Edits not shown yet: press Recompile or Ctrl+Enter.'
            : lastCompiledAt !== undefined
              ? `Compiled at ${time(lastCompiledAt)}`
              : ''}
      </span>
    </div>
  );
}

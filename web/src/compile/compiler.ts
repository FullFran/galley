// Overleaf-style compile control for the preview. With auto-compile on, edits
// render after a short pause; with it off, edits only mark the preview as out
// of date until the user presses Recompile (or Ctrl/Cmd+Enter). A change of
// source (opening the repository, a save moving the head) always renders.
// Only one render runs at a time; requests made meanwhile coalesce into one.

export interface CompileState {
  compiling: boolean;
  /** Edits made since the last render started. */
  stale: boolean;
  /** `now()` when the last render finished. */
  lastCompiledAt?: number;
}

export interface CompilerOptions {
  run: () => Promise<void>;
  auto: boolean;
  debounceMs: number;
  onState: (state: CompileState) => void;
  now?: () => number;
}

export interface Compiler {
  edited(): void;
  recompile(): void;
  sourceChanged(): void;
  setAuto(auto: boolean): void;
  dispose(): void;
}

export function createCompiler({ run, auto: initialAuto, debounceMs, onState, now = Date.now }: CompilerOptions): Compiler {
  let auto = initialAuto;
  let state: CompileState = { compiling: false, stale: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let again = false;
  let disposed = false;

  const set = (next: Partial<CompileState>) => {
    state = { ...state, ...next };
    if (state.lastCompiledAt === undefined) delete state.lastCompiledAt;
    if (!disposed) onState(state);
  };
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const start = () => {
    cancel();
    if (disposed) return;
    if (state.compiling) {
      again = true;
      return;
    }
    set({ compiling: true, stale: false });
    run()
      .catch(() => undefined)
      .then(() => {
        set({ compiling: false, lastCompiledAt: now() });
        if (again) {
          again = false;
          start();
        }
      });
  };
  const schedule = () => {
    cancel();
    if (!disposed) timer = setTimeout(start, debounceMs);
  };

  return {
    edited() {
      if (auto) schedule();
      set({ stale: true });
    },
    recompile: start,
    sourceChanged: start,
    setAuto(next) {
      auto = next;
      if (auto && state.stale) schedule();
      else if (!auto) cancel();
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/** Ctrl+Enter (Windows, Linux) or Cmd+Enter (macOS). */
export function isRecompileShortcut(e: KeyLike): boolean {
  return e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
}

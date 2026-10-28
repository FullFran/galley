import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompiler, isRecompileShortcut, type CompileState } from './compiler';

function setup(auto: boolean) {
  const runs: Array<() => void> = [];
  const states: CompileState[] = [];
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        runs.push(resolve);
      }),
  );
  let clock = 1000;
  const compiler = createCompiler({ run, auto, debounceMs: 300, now: () => clock, onState: (s) => states.push(s) });
  const finish = async () => {
    clock += 500;
    runs.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { compiler, run, states, finish, last: () => states[states.length - 1] };
}

describe('createCompiler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not render on edit when auto-compile is off', () => {
    const { compiler, run, last } = setup(false);
    compiler.edited();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
    expect(last()).toEqual({ compiling: false, stale: true });
  });

  it('renders at once on Recompile and records the time', async () => {
    const { compiler, run, last, finish } = setup(false);
    compiler.edited();
    compiler.recompile();
    expect(run).toHaveBeenCalledTimes(1);
    expect(last()).toEqual({ compiling: true, stale: false });
    await finish();
    expect(last()).toEqual({ compiling: false, stale: false, lastCompiledAt: 1500 });
  });

  it('renders edits after a pause when auto-compile is on', () => {
    const { compiler, run } = setup(true);
    compiler.edited();
    vi.advanceTimersByTime(200);
    compiler.edited();
    vi.advanceTimersByTime(299);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('renders when the source changes, even with auto-compile off', () => {
    const { compiler, run } = setup(false);
    compiler.sourceChanged();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs one more render when asked while compiling', async () => {
    const { compiler, run, finish } = setup(false);
    compiler.recompile();
    compiler.recompile();
    compiler.recompile();
    expect(run).toHaveBeenCalledTimes(1);
    await finish();
    expect(run).toHaveBeenCalledTimes(2);
    await finish();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('compiles pending edits when auto-compile is turned on', () => {
    const { compiler, run } = setup(false);
    compiler.edited();
    compiler.setAuto(true);
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps working after a failed render', async () => {
    const { compiler, run, last } = setup(false);
    run.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    compiler.recompile();
    await Promise.resolve();
    await Promise.resolve();
    expect(last()?.compiling).toBe(false);
    compiler.recompile();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stops scheduling after dispose', () => {
    const { compiler, run } = setup(true);
    compiler.edited();
    compiler.dispose();
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('isRecompileShortcut', () => {
  const key = (init: Partial<KeyboardEvent>) => ({ key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init });

  it('accepts Ctrl+Enter and Cmd+Enter', () => {
    expect(isRecompileShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isRecompileShortcut(key({ metaKey: true }))).toBe(true);
  });

  it('ignores plain Enter and other combinations', () => {
    expect(isRecompileShortcut(key({}))).toBe(false);
    expect(isRecompileShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isRecompileShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isRecompileShortcut(key({ key: 's', ctrlKey: true }))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import initScript from '../../public/theme-init.js?raw';
import { applyTheme, readTheme, THEME_KEY, writeTheme } from './theme';

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
};
const broken = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};
const root = () => ({ dataset: {} as Record<string, string | undefined> });

describe('theme preference', () => {
  it('defaults to System', () => {
    expect(readTheme(memory())).toBe('system');
    expect(readTheme(undefined)).toBe('system');
  });

  it('stores Light and Dark, and System removes the stored value', () => {
    const store = memory();
    writeTheme('dark', store);
    expect(store.data.get(THEME_KEY)).toBe('dark');
    expect(readTheme(store)).toBe('dark');
    writeTheme('system', store);
    expect(store.data.has(THEME_KEY)).toBe(false);
  });

  it('ignores unknown values and tolerates blocked storage', () => {
    const store = memory();
    store.setItem(THEME_KEY, 'neon');
    expect(readTheme(store)).toBe('system');
    expect(readTheme(broken)).toBe('system');
    expect(() => writeTheme('dark', broken)).not.toThrow();
  });

  it('sets data-theme for Light and Dark, and System removes the attribute', () => {
    const el = root();
    applyTheme(el, 'dark');
    expect(el.dataset.theme).toBe('dark');
    applyTheme(el, 'light');
    expect(el.dataset.theme).toBe('light');
    applyTheme(el, 'system');
    expect('theme' in el.dataset).toBe(false);
  });
});

describe('pre-paint theme script (public/theme-init.js)', () => {
  const run = (storage: unknown) => {
    const documentElement = root();
    new Function('document', 'localStorage', initScript)({ documentElement }, storage);
    return documentElement.dataset;
  };

  it('applies a stored Light or Dark theme before the app loads', () => {
    const store = memory();
    store.setItem(THEME_KEY, 'dark');
    expect(run(store).theme).toBe('dark');
  });

  it('applies nothing for System, unknown values or blocked storage', () => {
    expect(run(memory()).theme).toBeUndefined();
    const store = memory();
    store.setItem(THEME_KEY, '"><script>');
    expect(run(store).theme).toBeUndefined();
    expect(() => run(broken)).not.toThrow();
  });
});

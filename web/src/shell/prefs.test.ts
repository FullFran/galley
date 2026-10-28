import { describe, expect, it } from 'vitest';
import {
  dismissSetup,
  isSetupDismissed,
  onPrefsChange,
  readContentsTab,
  readPrefs,
  resolveEditorMode,
  writeContentsTab,
  writePrefs,
} from './prefs';

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

describe('Contents tab', () => {
  it('defaults to Outline and is remembered per repository', () => {
    const store = memory();
    expect(readContentsTab('o/a', store)).toBe('outline');
    writeContentsTab('o/a', 'files', store);
    expect(readContentsTab('o/a', store)).toBe('files');
    expect(readContentsTab('o/b', store)).toBe('outline');
  });

  it('falls back to Outline on unknown values and blocked storage', () => {
    const store = memory();
    store.setItem('galley:contents-tab:o/a', 'evil');
    expect(readContentsTab('o/a', store)).toBe('outline');
    expect(readContentsTab('o/a', broken)).toBe('outline');
    expect(() => writeContentsTab('o/a', 'files', broken)).not.toThrow();
  });
});

describe('setup banner dismissal', () => {
  it('is per repository', () => {
    const store = memory();
    expect(isSetupDismissed('o/a', store)).toBe(false);
    dismissSetup('o/a', store);
    expect(isSetupDismissed('o/a', store)).toBe(true);
    expect(isSetupDismissed('o/b', store)).toBe(false);
  });

  it('tolerates blocked storage (the banner just shows again)', () => {
    expect(isSetupDismissed('o/a', broken)).toBe(false);
    expect(() => dismissSetup('o/a', broken)).not.toThrow();
  });
});

describe('preferences', () => {
  it('stores the auto-compile default', () => {
    const store = memory();
    expect(readPrefs(store)).toEqual({});
    writePrefs({ autoCompile: true }, store);
    expect(readPrefs(store)).toEqual({ autoCompile: true });
  });

  it('drops values of the wrong type and survives corrupt or blocked storage', () => {
    const store = memory();
    store.setItem('galley:prefs', '{"autoCompile":"yes"}');
    expect(readPrefs(store)).toEqual({});
    store.setItem('galley:prefs', 'nope');
    expect(readPrefs(store)).toEqual({});
    expect(readPrefs(broken)).toEqual({});
    expect(() => writePrefs({ autoCompile: false }, broken)).not.toThrow();
  });
});

describe('editor preferences', () => {
  it('stores the editor mode and Vim next to the other preferences', () => {
    const store = memory();
    writePrefs({ autoCompile: true, editorMode: 'code', vim: true }, store);
    expect(readPrefs(store)).toEqual({ autoCompile: true, editorMode: 'code', vim: true });
  });

  it('drops unknown modes and non-boolean Vim values', () => {
    const store = memory();
    store.setItem('galley:prefs', '{"editorMode":"emacs","vim":"on"}');
    expect(readPrefs(store)).toEqual({});
  });

  it('tells listeners when preferences change in this tab', () => {
    const store = memory();
    const seen: unknown[] = [];
    const stop = onPrefsChange((p) => seen.push(p));
    writePrefs({ vim: true }, store);
    stop();
    writePrefs({ vim: false }, store);
    expect(seen).toEqual([{ vim: true }]);
  });
});

describe('editor mode', () => {
  it('uses the person’s own choice first', () => {
    expect(resolveEditorMode('code', 'writing', false)).toBe('code');
    expect(resolveEditorMode('writing', undefined, true)).toBe('writing');
  });

  it('then the .galley.yml default', () => {
    expect(resolveEditorMode(undefined, 'code', false)).toBe('code');
    expect(resolveEditorMode(undefined, 'writing', true)).toBe('writing');
  });

  it('else Writing for co-authors and Code for admins', () => {
    expect(resolveEditorMode(undefined, undefined, false)).toBe('writing');
    expect(resolveEditorMode(undefined, undefined, true)).toBe('code');
  });
});

import { describe, expect, it } from 'vitest';
import { readPrefs, writePrefs } from './prefs';
import { LAYOUTS, chooseFromSwitch, escapeExitsFocus, layoutOf, overlayOpen, showsPdf, shownPanes, switchPressed, togglePane } from './viewOptions';

const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe('view preferences', () => {
  it('default to editor and preview side by side, without focus mode', () => {
    const store = memory();
    expect(readPrefs(store)).toEqual({});
    expect(layoutOf(readPrefs(store))).toBe('both');
    expect(readPrefs(store).focus).toBeUndefined();
  });

  it('store the layout and focus mode', () => {
    const store = memory();
    writePrefs({ layout: 'preview', focus: true }, store);
    expect(readPrefs(store)).toEqual({ layout: 'preview', focus: true });
    expect(layoutOf(readPrefs(store))).toBe('preview');
    writePrefs({ layout: 'editor', focus: false }, store);
    expect(readPrefs(store)).toEqual({ layout: 'editor', focus: false });
  });

  it('drop an unknown layout and a non-boolean focus value', () => {
    const store = memory();
    store.setItem('galley:prefs', '{"layout":"pdf-maybe","focus":"yes"}');
    expect(readPrefs(store)).toEqual({});
    expect(layoutOf(readPrefs(store))).toBe('both');
  });

  it('keep the existing editor mode and auto-compile preferences next to them', () => {
    const store = memory();
    writePrefs({ autoCompile: true, editorMode: 'writing', layout: 'editor', focus: true }, store);
    expect(readPrefs(store)).toEqual({ autoCompile: true, editorMode: 'writing', layout: 'editor', focus: true });
  });
});

describe('the PDF layout', () => {
  it('is stored and read back like the other layouts, after them in the list', () => {
    const store = memory();
    writePrefs({ layout: 'pdf' }, store);
    expect(readPrefs(store)).toEqual({ layout: 'pdf' });
    expect(layoutOf(readPrefs(store))).toBe('pdf');
    expect(LAYOUTS).toEqual(['both', 'editor', 'preview', 'pdf']);
  });

  it('keeps the existing layouts and still drops unknown values', () => {
    const store = memory();
    for (const layout of ['both', 'editor', 'preview'] as const) {
      writePrefs({ layout }, store);
      expect(layoutOf(readPrefs(store))).toBe(layout);
    }
    store.setItem('galley:prefs', '{"layout":"PDF"}');
    expect(readPrefs(store)).toEqual({});
  });

  it('shows editor and PDF side by side while both fit, else the pane chosen with Edit | PDF', () => {
    expect(shownPanes('pdf', true, 'edit')).toBe('both');
    expect(shownPanes('pdf', false, 'edit')).toBe('edit');
    expect(shownPanes('pdf', false, 'preview')).toBe('preview');
    expect(switchPressed('pdf', true, 'edit')).toBeUndefined();
    expect(switchPressed('pdf', false, 'preview')).toBe('preview');
  });

  it('the toggle and Edit | PDF flip between editor only and PDF only at any width, keeping the PDF layout', () => {
    for (const fits of [true, false]) {
      expect(chooseFromSwitch('pdf', fits, 'preview')).toEqual({ view: 'preview', single: true });
      expect(chooseFromSwitch('pdf', fits, 'edit')).toEqual({ view: 'edit', single: true });
      expect(togglePane('pdf', fits, 'preview', true)).toEqual({ view: 'edit', single: true });
      expect(togglePane('pdf', fits, 'edit', true)).toEqual({ view: 'preview', single: true });
    }
    // From side by side the toggle shows the PDF only.
    expect(togglePane('pdf', true, 'edit')).toEqual({ view: 'preview', single: true });
  });

  it('shows one pane once a half was chosen, and both again when the layout is chosen anew', () => {
    expect(shownPanes('pdf', true, 'preview', true)).toBe('preview');
    expect(switchPressed('pdf', true, 'preview', true)).toBe('preview');
    expect(shownPanes('pdf', true, 'edit', true)).toBe('edit');
    expect(shownPanes('pdf', true, 'edit', false)).toBe('both');
    // The single-pane choice does not change the other layouts.
    expect(shownPanes('both', true, 'edit', true)).toBe('both');
    expect(togglePane('both', true, 'edit', true)).toEqual({ layout: 'preview' });
  });

  it('names which pane shows the PDF', () => {
    expect(showsPdf('pdf')).toBe(true);
    for (const layout of ['both', 'editor', 'preview'] as const) expect(showsPdf(layout)).toBe(false);
  });
});

describe('panes shown', () => {
  it('side by side when the layout is both and both fit', () => {
    expect(shownPanes('both', true, 'edit')).toBe('both');
  });

  it('one pane chosen with Edit | Preview when both do not fit', () => {
    expect(shownPanes('both', false, 'edit')).toBe('edit');
    expect(shownPanes('both', false, 'preview')).toBe('preview');
  });

  it('only the chosen pane for a single-pane layout, at any width', () => {
    for (const fits of [true, false]) {
      expect(shownPanes('editor', fits, 'preview')).toBe('edit');
      expect(shownPanes('preview', fits, 'edit')).toBe('preview');
    }
  });

  it('marks the shown pane in Edit | Preview, and none while both show', () => {
    expect(switchPressed('both', true, 'edit')).toBeUndefined();
    expect(switchPressed('both', false, 'preview')).toBe('preview');
    expect(switchPressed('editor', true, 'preview')).toBe('edit');
  });
});

describe('text/preview toggle', () => {
  it('switches between text only and preview only', () => {
    expect(togglePane('editor', true, 'edit')).toEqual({ layout: 'preview' });
    expect(togglePane('preview', true, 'edit')).toEqual({ layout: 'editor' });
    expect(togglePane('preview', false, 'preview')).toEqual({ layout: 'editor' });
  });

  it('from side by side, shows the preview only (the other pane than the text being edited)', () => {
    expect(togglePane('both', true, 'edit')).toEqual({ layout: 'preview' });
    expect(togglePane('both', true, 'preview')).toEqual({ layout: 'editor' });
  });

  it('on a narrow screen with both panes chosen, flips the one shown without changing the layout', () => {
    expect(togglePane('both', false, 'edit')).toEqual({ view: 'preview' });
    expect(togglePane('both', false, 'preview')).toEqual({ view: 'edit' });
  });

  it('Edit | Preview picks a single pane, or the shown pane on a narrow screen', () => {
    expect(chooseFromSwitch('both', true, 'preview')).toEqual({ layout: 'preview' });
    expect(chooseFromSwitch('editor', true, 'preview')).toEqual({ layout: 'preview' });
    expect(chooseFromSwitch('preview', false, 'edit')).toEqual({ layout: 'editor' });
    expect(chooseFromSwitch('both', false, 'preview')).toEqual({ view: 'preview' });
  });
});

describe('Escape leaves focus mode', () => {
  const esc = { key: 'Escape', defaultPrevented: false };

  it('when focus mode is on and nothing else is open', () => {
    expect(escapeExitsFocus(esc, true, false)).toBe(true);
  });

  it('not when focus mode is off, another key, a dialog, menu or tour is open, or the editor used Escape', () => {
    expect(escapeExitsFocus(esc, false, false)).toBe(false);
    expect(escapeExitsFocus({ key: 'Enter', defaultPrevented: false }, true, false)).toBe(false);
    expect(escapeExitsFocus(esc, true, true)).toBe(false);
    expect(escapeExitsFocus({ key: 'Escape', defaultPrevented: true }, true, false)).toBe(false);
  });

  it('sees open dialogs, menus, popovers and the tour', () => {
    const asked: string[] = [];
    const root = (hit: boolean) => ({
      querySelector: (sel: string) => {
        asked.push(sel);
        return hit ? {} : null;
      },
    });
    expect(overlayOpen(root(false))).toBe(false);
    expect(overlayOpen(root(true))).toBe(true);
    const selector = asked.join(',');
    for (const part of ['dialog[open]', '.popover:not([hidden])', '.driver-popover']) expect(selector).toContain(part);
  });
});

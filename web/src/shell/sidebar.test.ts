import { describe, expect, it } from 'vitest';
import { initialSidebar, readCollapsed, reduceSidebar, viewportFor, writeCollapsed, SIDEBAR_KEY } from './sidebar';

describe('viewportFor', () => {
  it('splits at 768 and 1024 px', () => {
    expect(viewportFor(1440)).toBe('wide');
    expect(viewportFor(1024)).toBe('wide');
    expect(viewportFor(1023)).toBe('medium');
    expect(viewportFor(768)).toBe('medium');
    expect(viewportFor(767)).toBe('narrow');
  });
});

describe('initialSidebar', () => {
  it('is expanded on wide screens and collapsed on medium ones by default', () => {
    expect(initialSidebar(1280)).toMatchObject({ viewport: 'wide', collapsed: false, drawerOpen: false });
    expect(initialSidebar(900)).toMatchObject({ viewport: 'medium', collapsed: true, drawerOpen: false });
  });

  it('follows a stored preference', () => {
    expect(initialSidebar(1280, true).collapsed).toBe(true);
    expect(initialSidebar(900, false).collapsed).toBe(false);
  });

  it('starts with the drawer closed on phones', () => {
    expect(initialSidebar(390)).toMatchObject({ viewport: 'narrow', drawerOpen: false });
  });
});

describe('reduceSidebar', () => {
  it('collapses and expands on wide and medium screens, remembering the choice', () => {
    const wide = initialSidebar(1280);
    const collapsed = reduceSidebar(wide, { type: 'toggle' });
    expect(collapsed).toMatchObject({ collapsed: true, preference: true, drawerOpen: false });
    expect(reduceSidebar(collapsed, { type: 'toggle' })).toMatchObject({ collapsed: false, preference: false });
  });

  it('opens and closes the drawer on phones without touching the collapse preference', () => {
    const phone = initialSidebar(390, true);
    const open = reduceSidebar(phone, { type: 'toggle' });
    expect(open).toMatchObject({ drawerOpen: true, collapsed: true, preference: true });
    expect(reduceSidebar(open, { type: 'toggle' }).drawerOpen).toBe(false);
    expect(reduceSidebar(open, { type: 'closeDrawer' }).drawerOpen).toBe(false);
  });

  it('closes the drawer on navigation', () => {
    const open = reduceSidebar(initialSidebar(390), { type: 'toggle' });
    expect(reduceSidebar(open, { type: 'navigate' }).drawerOpen).toBe(false);
  });

  it('expands on request, for example when choosing Files from the icon rail', () => {
    const rail = initialSidebar(900);
    expect(reduceSidebar(rail, { type: 'expand' })).toMatchObject({ collapsed: false, preference: false });
    const phone = initialSidebar(390);
    expect(reduceSidebar(phone, { type: 'expand' })).toEqual(phone);
  });

  it('applies the default of the new size on resize unless the user chose', () => {
    const wide = initialSidebar(1280);
    expect(reduceSidebar(wide, { type: 'resize', width: 900 })).toMatchObject({ viewport: 'medium', collapsed: true });
    const chosen = reduceSidebar(wide, { type: 'toggle' });
    expect(reduceSidebar(reduceSidebar(chosen, { type: 'toggle' }), { type: 'resize', width: 900 }).collapsed).toBe(false);
  });

  it('closes the drawer when the screen grows past the phone size', () => {
    const open = reduceSidebar(initialSidebar(390), { type: 'toggle' });
    expect(reduceSidebar(open, { type: 'resize', width: 1280 })).toMatchObject({ viewport: 'wide', drawerOpen: false });
  });

  it('returns the same state when nothing changes', () => {
    const wide = initialSidebar(1280);
    expect(reduceSidebar(wide, { type: 'resize', width: 1300 })).toBe(wide);
    expect(reduceSidebar(wide, { type: 'navigate' })).toBe(wide);
  });
});

describe('collapse preference storage', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      data,
    };
  };

  it('round-trips the preference', () => {
    const storage = memory();
    expect(readCollapsed(storage)).toBeUndefined();
    writeCollapsed(storage, true);
    expect(storage.data.get(SIDEBAR_KEY)).toBe('collapsed');
    expect(readCollapsed(storage)).toBe(true);
    writeCollapsed(storage, false);
    expect(readCollapsed(storage)).toBe(false);
  });

  it('ignores unknown values and storage that throws', () => {
    const storage = memory();
    storage.setItem(SIDEBAR_KEY, 'sideways');
    expect(readCollapsed(storage)).toBeUndefined();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readCollapsed(broken)).toBeUndefined();
    expect(() => writeCollapsed(broken, true)).not.toThrow();
    expect(readCollapsed(undefined)).toBeUndefined();
  });
});

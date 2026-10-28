import { describe, expect, it } from 'vitest';
import { autoOpen, groupKeyAction, isGroupOpen, NAV_GROUPS_KEY, readGroups, toggleGroup, writeGroups } from './navGroups';

const memory = (init: Record<string, string> = {}) => {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
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
};

describe('nav group state', () => {
  it('keeps Review closed by default and Write always open', () => {
    expect(isGroupOpen('review', {}, 'full')).toBe(false);
    expect(isGroupOpen('write', { write: false }, 'full')).toBe(true);
    expect(isGroupOpen('admin', {}, 'full')).toBe(true);
  });

  it('toggles a collapsible group from what is shown', () => {
    const open = toggleGroup({}, 'review', 'full');
    expect(open).toEqual({ review: true });
    expect(toggleGroup(open, 'review', 'full')).toEqual({ review: false });
  });

  it('never collapses groups in the icon rail or the phone drawer', () => {
    expect(isGroupOpen('review', { review: false }, 'rail')).toBe(true);
    expect(isGroupOpen('review', { review: false }, 'drawer')).toBe(true);
    // Toggling there changes nothing.
    expect(toggleGroup({ review: false }, 'review', 'rail')).toEqual({ review: false });
  });

  it('opens the group of the active route, and leaves it alone otherwise', () => {
    expect(autoOpen({ review: false }, 'proposals')).toEqual({ review: true });
    const state = { review: false };
    expect(autoOpen(state, 'contents')).toBe(state);
    expect(autoOpen(state, undefined)).toBe(state);
    const open = { review: true };
    expect(autoOpen(open, 'proposals')).toBe(open);
  });

  it('maps ArrowRight/ArrowLeft to open/close', () => {
    expect(groupKeyAction('ArrowRight', false)).toBe('open');
    expect(groupKeyAction('ArrowRight', true)).toBeUndefined();
    expect(groupKeyAction('ArrowLeft', true)).toBe('close');
    expect(groupKeyAction('ArrowLeft', false)).toBeUndefined();
    expect(groupKeyAction('Enter', false)).toBeUndefined();
  });

  it('persists the state as JSON under galley:nav-groups', () => {
    const store = memory();
    writeGroups(store, { review: true });
    expect(store.data.get(NAV_GROUPS_KEY)).toBe('{"review":true}');
    expect(readGroups(store)).toEqual({ review: true });
  });

  it('ignores corrupt, foreign or blocked storage', () => {
    expect(readGroups(memory({ [NAV_GROUPS_KEY]: '{not json' }))).toEqual({});
    expect(readGroups(memory({ [NAV_GROUPS_KEY]: '[1,2]' }))).toEqual({});
    expect(readGroups(memory({ [NAV_GROUPS_KEY]: '{"review":"yes","__proto__":true,"other":true}' }))).toEqual({});
    expect(readGroups(broken)).toEqual({});
    expect(readGroups(undefined)).toEqual({});
    expect(() => writeGroups(broken, { review: true })).not.toThrow();
  });
});

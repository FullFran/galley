import { describe, expect, it } from 'vitest';
import { ADMIN_TABS, availableAdminTabs, DEFAULT_ADMIN_TAB, isPanelTab, leaveAdminArea, resolveAdminTab } from './adminTabs';

describe('admin area tabs', () => {
  it('shows Project settings, the admin panel tabs and View as co-author, in that order', () => {
    expect(availableAdminTabs().map((t) => t.id)).toEqual(['settings', 'people', 'access', 'shared', 'activity', 'view-as']);
    expect(DEFAULT_ADMIN_TAB).toBe('settings');
    expect(ADMIN_TABS.every((t) => t.available)).toBe(true);
  });

  it('resolves unknown and missing tabs to the default', () => {
    expect(resolveAdminTab(undefined)).toBe('settings');
    expect(resolveAdminTab('')).toBe('settings');
    expect(resolveAdminTab('sessions')).toBe('settings');
    expect(resolveAdminTab('__proto__')).toBe('settings');
    expect(resolveAdminTab('view-as')).toBe('view-as');
    expect(resolveAdminTab('activity')).toBe('activity');
  });

  it('marks the tabs served by the lazily loaded admin panel', () => {
    expect(['people', 'access', 'shared', 'activity'].every((t) => isPanelTab(t as never))).toBe(true);
    expect(isPanelTab('settings')).toBe(false);
    expect(isPanelTab('view-as')).toBe(false);
  });

  it('sends a confirmed non-admin away from an admin route, but waits while access is unknown', () => {
    expect(leaveAdminArea('people', false)).toBe(true);
    expect(leaveAdminArea('settings', false)).toBe(true);
    expect(leaveAdminArea('people', undefined)).toBe(false);
    expect(leaveAdminArea('people', true)).toBe(false);
    expect(leaveAdminArea(undefined, false)).toBe(false);
  });
});

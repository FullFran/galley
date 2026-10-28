import { describe, expect, it } from 'vitest';
import { ADMIN_TABS, availableAdminTabs, DEFAULT_ADMIN_TAB, resolveAdminTab } from './adminTabs';

describe('admin area tabs', () => {
  it('shows Project settings and View as co-author, in that order', () => {
    expect(availableAdminTabs().map((t) => t.id)).toEqual(['settings', 'view-as']);
    expect(DEFAULT_ADMIN_TAB).toBe('settings');
  });

  it('reserves tabs for the future admin panel without showing them', () => {
    const future = ADMIN_TABS.filter((t) => !t.available).map((t) => t.id);
    expect(future).toEqual(['people', 'sessions', 'allowlist']);
  });

  it('resolves unknown, missing and unavailable tabs to the default', () => {
    expect(resolveAdminTab(undefined)).toBe('settings');
    expect(resolveAdminTab('')).toBe('settings');
    expect(resolveAdminTab('people')).toBe('settings');
    expect(resolveAdminTab('__proto__')).toBe('settings');
    expect(resolveAdminTab('view-as')).toBe('view-as');
  });
});

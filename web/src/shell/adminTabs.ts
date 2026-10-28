// Tabs of the Admin area. Future admin panel tabs (C6) are declared but not
// available yet, so the structure is ready and nothing unbuilt is shown.
// `resolveAdminTab` maps any raw value (a URL segment) to a shown tab.

export type AdminTabId = 'settings' | 'view-as' | 'people' | 'sessions' | 'allowlist';

export const ADMIN_TABS: readonly { id: AdminTabId; available: boolean }[] = [
  { id: 'settings', available: true },
  { id: 'view-as', available: true },
  { id: 'people', available: false },
  { id: 'sessions', available: false },
  { id: 'allowlist', available: false },
];

export const DEFAULT_ADMIN_TAB: AdminTabId = 'settings';

export function availableAdminTabs() {
  return ADMIN_TABS.filter((t) => t.available);
}

export function resolveAdminTab(raw: string | undefined): AdminTabId {
  return availableAdminTabs().find((t) => t.id === raw)?.id ?? DEFAULT_ADMIN_TAB;
}

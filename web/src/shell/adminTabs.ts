// Tabs of the Admin area. `resolveAdminTab` maps any raw value (a URL
// segment) to a shown tab. The admin panel tabs (C6) are rendered by a lazily
// loaded module (ui/admin/AdminPanels), so co-authors never download it.

export type AdminTabId = 'settings' | 'people' | 'access' | 'shared' | 'activity' | 'view-as';

export const ADMIN_TABS: readonly { id: AdminTabId; available: boolean }[] = [
  { id: 'settings', available: true },
  { id: 'people', available: true },
  { id: 'access', available: true },
  { id: 'shared', available: true },
  { id: 'activity', available: true },
  { id: 'view-as', available: true },
];

export const DEFAULT_ADMIN_TAB: AdminTabId = 'settings';

const PANEL_TABS: ReadonlySet<AdminTabId> = new Set(['people', 'access', 'shared', 'activity']);

export type PanelTabId = 'people' | 'access' | 'shared' | 'activity';

export function availableAdminTabs() {
  return ADMIN_TABS.filter((t) => t.available);
}

export function resolveAdminTab(raw: string | undefined): AdminTabId {
  return availableAdminTabs().find((t) => t.id === raw)?.id ?? DEFAULT_ADMIN_TAB;
}

/** Tabs served by the admin panel module. */
export function isPanelTab(tab: AdminTabId | undefined): tab is PanelTabId {
  return tab !== undefined && PANEL_TABS.has(tab);
}

/**
 * A deep link into the Admin area by someone confirmed not to be an admin goes
 * back to the paper. `admin` is undefined while access is still being looked up.
 */
export function leaveAdminArea(tab: AdminTabId | undefined, admin: boolean | undefined): boolean {
  return tab !== undefined && admin === false;
}

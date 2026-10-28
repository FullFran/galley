// The sidebar navigation, declared once as data. The desktop sidebar, the
// icon rail and the phone drawer all render this list, so a new entry cannot
// appear in one of them only. Labels come from the message catalog.
//
// Grouped by task, in the order of the work (write, then review), with the
// admin entry last behind a separator and shown to admins only. The
// repository switcher sits above the groups and Help, the account and the
// credit sit in the footer, outside these groups.

import type { Messages } from '../i18n';

export type NavId = 'contents' | 'proposals' | 'comments' | 'chat' | 'admin';

export type GroupId = 'write' | 'review' | 'admin';

export type IconName = 'library' | 'outline' | 'folder' | 'proposals' | 'comment' | 'chat' | 'settings' | 'help' | 'info';

export interface NavItem {
  id: NavId;
  icon: IconName;
  group: GroupId;
  /** `repo`: needs an open repository; `admin`: also needs admin rights there. */
  requires: 'repo' | 'admin';
  /** `data-tour` anchor for the guided tour. */
  tour?: string;
}

export interface NavGroup {
  id: GroupId;
  /** Has a header that folds it away (desktop sidebar only). */
  collapsible: boolean;
  /** Drawn after a separator: used rarely, unlike the entries above it. */
  separated: boolean;
  items: NavItem[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'contents', icon: 'outline', group: 'write', requires: 'repo' },
  { id: 'proposals', icon: 'proposals', group: 'review', requires: 'repo', tour: 'proposals' },
  { id: 'comments', icon: 'comment', group: 'review', requires: 'repo' },
  { id: 'chat', icon: 'chat', group: 'review', requires: 'repo' },
  { id: 'admin', icon: 'settings', group: 'admin', requires: 'admin' },
];

const GROUPS: { id: GroupId; collapsible: boolean; separated: boolean }[] = [
  { id: 'write', collapsible: false, separated: false },
  { id: 'review', collapsible: true, separated: false },
  { id: 'admin', collapsible: false, separated: true },
];

/** The entries this person can use right now, in display groups. Empty groups are dropped. */
export function visibleNav({ repoOpen, admin }: { repoOpen: boolean; admin: boolean }): NavGroup[] {
  const allowed = (item: NavItem) => repoOpen && (item.requires === 'repo' || admin);
  return GROUPS.map((g) => ({ ...g, items: NAV_ITEMS.filter((item) => item.group === g.id && allowed(item)) })).filter(
    (group) => group.items.length > 0,
  );
}

export function groupOf(id: NavId): GroupId {
  return NAV_ITEMS.find((i) => i.id === id)?.group ?? 'write';
}

export function isCollapsible(id: GroupId): boolean {
  return GROUPS.find((g) => g.id === id)?.collapsible ?? false;
}

export function navLabel(id: NavId, t: Messages): string {
  return t.nav[id];
}

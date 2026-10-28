// The sidebar navigation, declared once as data. The desktop sidebar, the
// icon rail and the phone drawer all render this list, so a new entry cannot
// appear in one of them only. Labels come from the message catalog.

import type { Messages } from '../i18n';

export type NavId = 'repos' | 'paper' | 'files' | 'proposals' | 'settings' | 'tour' | 'about';

export type IconName = 'library' | 'outline' | 'folder' | 'proposals' | 'settings' | 'help' | 'info';

export interface NavItem {
  id: NavId;
  icon: IconName;
  group: 'work' | 'admin' | 'help';
  /** `repo`: needs an open repository; `admin`: also needs admin rights there. */
  requires?: 'repo' | 'admin';
  /** `data-tour` anchor for the guided tour. */
  tour?: string;
}

export interface NavGroup {
  id: NavItem['group'];
  /** Drawn after a separator: used rarely, unlike the entries above it. */
  separated: boolean;
  items: NavItem[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'repos', icon: 'library', group: 'work' },
  { id: 'paper', icon: 'outline', group: 'work', requires: 'repo' },
  { id: 'files', icon: 'folder', group: 'work', requires: 'repo' },
  { id: 'proposals', icon: 'proposals', group: 'work', requires: 'repo', tour: 'proposals' },
  { id: 'settings', icon: 'settings', group: 'admin', requires: 'admin' },
  { id: 'tour', icon: 'help', group: 'help', tour: 'help' },
  { id: 'about', icon: 'info', group: 'help' },
];

const GROUPS: NavItem['group'][] = ['work', 'admin', 'help'];

/** The entries this person can use right now, in display groups. Empty groups are dropped. */
export function visibleNav({ repoOpen, admin }: { repoOpen: boolean; admin: boolean }): NavGroup[] {
  const allowed = (item: NavItem) =>
    item.requires === undefined || (repoOpen && (item.requires === 'repo' || admin));
  return GROUPS.map((id) => ({
    id,
    separated: id !== 'work',
    items: NAV_ITEMS.filter((item) => item.group === id && allowed(item)),
  })).filter((group) => group.items.length > 0);
}

export function navLabel(id: NavId, t: Messages): string {
  return t.nav[id];
}

// Open/closed state of the collapsible sidebar groups. One map stored as JSON
// (guarded), the way Álvaro's apps keep `sidebar:groups:expanded`. Groups
// fold only in the full desktop sidebar: in the icon rail and the phone
// drawer every entry stays reachable.

import { groupOf, isCollapsible, type GroupId, type NavId } from './nav';

export type GroupState = Partial<Record<GroupId, boolean>>;
export type SidebarMode = 'full' | 'rail' | 'drawer';

export const NAV_GROUPS_KEY = 'galley:nav-groups';

const DEFAULT_OPEN: Partial<Record<GroupId, boolean>> = { review: false };
const IDS: readonly GroupId[] = ['write', 'review', 'admin'];

export function isGroupOpen(id: GroupId, state: GroupState, mode: SidebarMode): boolean {
  if (!isCollapsible(id) || mode !== 'full') return true;
  return state[id] ?? DEFAULT_OPEN[id] ?? true;
}

export function toggleGroup(state: GroupState, id: GroupId, mode: SidebarMode): GroupState {
  if (!isCollapsible(id) || mode !== 'full') return state;
  return { ...state, [id]: !isGroupOpen(id, state, mode) };
}

/** Opens the group holding the active route; the same object when nothing changes. */
export function autoOpen(state: GroupState, active: NavId | undefined): GroupState {
  if (!active) return state;
  const id = groupOf(active);
  if (!isCollapsible(id) || state[id] === true) return state;
  return { ...state, [id]: true };
}

/** ArrowRight opens and ArrowLeft closes a group header (Enter and Space click the button). */
export function groupKeyAction(key: string, open: boolean): 'open' | 'close' | undefined {
  if (key === 'ArrowRight' && !open) return 'open';
  if (key === 'ArrowLeft' && open) return 'close';
  return undefined;
}

export function readGroups(storage: Pick<Storage, 'getItem'> | undefined): GroupState {
  try {
    const raw = storage?.getItem(NAV_GROUPS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: GroupState = {};
    for (const id of IDS) {
      const value = (parsed as Record<string, unknown>)[id];
      if (typeof value === 'boolean') out[id] = value;
      else if (value !== undefined) return {};
    }
    return out;
  } catch {
    return {};
  }
}

export function writeGroups(storage: Pick<Storage, 'setItem'> | undefined, state: GroupState): void {
  try {
    storage?.setItem(NAV_GROUPS_KEY, JSON.stringify(state));
  } catch {
    // Best effort: the groups just open with their defaults next time.
  }
}

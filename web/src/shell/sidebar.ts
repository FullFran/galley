// Sidebar state: a durable collapse preference for wider screens, and a
// separate, momentary drawer on phones. Sharing one flag would mean that
// collapsing on a laptop leaves the phone without navigation.

export type Viewport = 'wide' | 'medium' | 'narrow';

export interface SidebarState {
  viewport: Viewport;
  /** Icons only (3.5rem) instead of the full 16rem sidebar; wide and medium screens. */
  collapsed: boolean;
  /** The user's own choice, once made; it wins over the per-size default. */
  preference?: boolean;
  /** Phones: the off-canvas drawer is showing. */
  drawerOpen: boolean;
}

export type SidebarAction =
  | { type: 'toggle' }
  | { type: 'expand' }
  | { type: 'closeDrawer' }
  | { type: 'navigate' }
  | { type: 'resize'; width: number };

export const SIDEBAR_KEY = 'galley:sidebar';

export function viewportFor(width: number): Viewport {
  if (width >= 1024) return 'wide';
  if (width >= 768) return 'medium';
  return 'narrow';
}

export function initialSidebar(width: number, stored?: boolean): SidebarState {
  const viewport = viewportFor(width);
  return { viewport, collapsed: stored ?? viewport !== 'wide', preference: stored, drawerOpen: false };
}

export function reduceSidebar(state: SidebarState, action: SidebarAction): SidebarState {
  switch (action.type) {
    case 'toggle':
      if (state.viewport === 'narrow') return { ...state, drawerOpen: !state.drawerOpen };
      return { ...state, collapsed: !state.collapsed, preference: !state.collapsed };
    case 'expand':
      if (state.viewport === 'narrow' || !state.collapsed) return state;
      return { ...state, collapsed: false, preference: false };
    case 'closeDrawer':
    case 'navigate':
      return state.drawerOpen ? { ...state, drawerOpen: false } : state;
    case 'resize': {
      const viewport = viewportFor(action.width);
      if (viewport === state.viewport) return state;
      return {
        ...state,
        viewport,
        collapsed: state.preference ?? viewport !== 'wide',
        drawerOpen: viewport === 'narrow' && state.drawerOpen,
      };
    }
  }
}

type Readable = Pick<Storage, 'getItem'>;
type Writable = Pick<Storage, 'setItem'>;

/** The stored collapse preference; undefined when unset, unreadable or blocked. */
export function readCollapsed(storage: Readable | undefined): boolean | undefined {
  try {
    const value = storage?.getItem(SIDEBAR_KEY);
    if (value === 'collapsed') return true;
    if (value === 'expanded') return false;
  } catch {
    // Private windows and blocked site data: fall back to the default.
  }
  return undefined;
}

export function writeCollapsed(storage: Writable | undefined, collapsed: boolean): void {
  try {
    storage?.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // Best effort: the preference is a convenience.
  }
}

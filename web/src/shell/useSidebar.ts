import type { RefObject } from 'preact';
import { useEffect, useReducer, useRef } from 'preact/hooks';
import { initialSidebar, readCollapsed, reduceSidebar, writeCollapsed, type SidebarAction, type SidebarState } from './sidebar';

export interface SidebarControl {
  state: SidebarState;
  dispatch: (action: SidebarAction) => void;
  /** The header button that opens the phone drawer; focus returns there when it closes. */
  toggleRef: RefObject<HTMLButtonElement | null>;
  /** The sidebar element, to move focus into the drawer when it opens. */
  panelRef: RefObject<HTMLElement | null>;
}

const storage = (): Storage | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};
const width = () => (typeof window === 'undefined' ? 1280 : window.innerWidth);

/** Ctrl/Cmd+B means bold in text fields, so the shortcut leaves them alone. */
function typingInField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Owns the sidebar state for the whole signed-in app, so it survives moving
 * between screens: the collapse preference (stored), the phone drawer (not
 * stored, closed on navigation), Ctrl/Cmd+B, Escape and focus return.
 */
export function useSidebar(): SidebarControl {
  const [state, dispatch] = useReducer(reduceSidebar, undefined, () => initialSidebar(width(), readCollapsed(storage())));
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (state.preference !== undefined) writeCollapsed(storage(), state.preference);
  }, [state.preference]);

  useEffect(() => {
    const onResize = () => dispatch({ type: 'resize', width: window.innerWidth });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return dispatch({ type: 'closeDrawer' });
      if (e.key.toLowerCase() !== 'b' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (typingInField(e.target)) return;
      e.preventDefault();
      dispatch({ type: 'toggle' });
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (state.drawerOpen) panelRef.current?.querySelector<HTMLElement>('button, a[href]')?.focus();
    else if (wasOpen.current && toggleRef.current?.isConnected) toggleRef.current.focus();
    wasOpen.current = state.drawerOpen;
  }, [state.drawerOpen]);

  return { state, dispatch, toggleRef, panelRef };
}

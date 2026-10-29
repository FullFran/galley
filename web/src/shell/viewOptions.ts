// View options of the workspace: which panes show (layout), the one-click
// text/preview toggle and focus mode. Pure rules; the workspace wires them.

import { LAYOUTS, type Layout, type Prefs } from './prefs';

export { LAYOUTS, type Layout };

/** The pane shown when only one fits (the Edit | Preview switch). */
export type PaneView = 'edit' | 'preview';

/** A change the toggle asks for: a new (stored) layout, or the pane shown on a narrow screen. */
export type ViewChange = { layout: Layout } | { view: PaneView };

export function layoutOf(prefs: Prefs): Layout {
  return prefs.layout ?? 'both';
}

/**
 * What the workspace shows. `fits` is whether editor and preview fit side by
 * side; `view` is the Edit | Preview choice used when they do not.
 */
export function shownPanes(layout: Layout, fits: boolean, view: PaneView): 'both' | PaneView {
  if (layout === 'editor') return 'edit';
  if (layout === 'preview') return 'preview';
  return fits ? 'both' : view;
}

/** The pressed half of Edit | Preview; none while both panes show. */
export function switchPressed(layout: Layout, fits: boolean, view: PaneView): PaneView | undefined {
  const shown = shownPanes(layout, fits, view);
  return shown === 'both' ? undefined : shown;
}

const layoutFor = (view: PaneView): Layout => (view === 'edit' ? 'editor' : 'preview');

/**
 * Choosing a half of Edit | Preview. On a narrow screen with both panes
 * chosen it only picks the pane shown (as before, not stored); otherwise it
 * switches to that single-pane layout.
 */
export function chooseFromSwitch(layout: Layout, fits: boolean, view: PaneView): ViewChange {
  return layout === 'both' && !fits ? { view } : { layout: layoutFor(view) };
}

/**
 * The text/preview toggle (header and Ctrl+Alt+V): text only becomes preview
 * only and back. From side by side it shows the pane other than the one the
 * Edit | Preview switch last chose (the preview, by default).
 */
export function togglePane(layout: Layout, fits: boolean, view: PaneView): ViewChange {
  const shown = shownPanes(layout, fits, view);
  const current = shown === 'both' ? view : shown;
  const other: PaneView = current === 'preview' ? 'edit' : 'preview';
  return chooseFromSwitch(layout, fits, other);
}

/** Escape leaves focus mode unless something else (a dialog, a menu, the tour, the editor) takes it. */
export function escapeExitsFocus(e: { key: string; defaultPrevented: boolean }, focus: boolean, overlay: boolean): boolean {
  return focus && e.key === 'Escape' && !e.defaultPrevented && !overlay;
}

const OVERLAYS = ['dialog[open]', '[role="dialog"]:not([hidden])', '.popover:not([hidden])', '.driver-popover'].join(', ');

/** Whether a dialog, menu, popover or the tour is open in `root`. */
export function overlayOpen(root: Pick<ParentNode, 'querySelector'>): boolean {
  return root.querySelector(OVERLAYS) !== null;
}

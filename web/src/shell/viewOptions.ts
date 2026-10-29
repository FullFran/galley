// View options of the workspace: which panes show (layout), the one-click
// text/preview toggle and focus mode. Pure rules; the workspace wires them.

import { LAYOUTS, type Layout, type Prefs } from './prefs';

export { LAYOUTS, type Layout };

/** The pane shown when only one fits (the Edit | Preview switch). */
export type PaneView = 'edit' | 'preview';

/**
 * A change the toggle asks for: a new (stored) layout, or the pane shown on a
 * narrow screen. `single` (PDF layout only) shows that pane alone even while
 * both fit, until the layout is chosen again; it is not stored.
 */
export type ViewChange = { layout: Layout } | { view: PaneView; single?: true };

export function layoutOf(prefs: Prefs): Layout {
  return prefs.layout ?? 'both';
}

/** Whether the second pane shows the compiled PDF of the default branch instead of the live preview. */
export function showsPdf(layout: Layout): boolean {
  return layout === 'pdf';
}

/**
 * What the workspace shows. `fits` is whether editor and preview fit side by
 * side; `view` is the Edit | Preview choice used when they do not. With the
 * PDF layout (editor + compiled PDF), `single` shows the `view` pane alone.
 */
export function shownPanes(layout: Layout, fits: boolean, view: PaneView, single = false): 'both' | PaneView {
  if (layout === 'editor') return 'edit';
  if (layout === 'preview') return 'preview';
  if (layout === 'pdf' && single) return view;
  // 'both' and 'pdf': the second pane is the preview or the PDF.
  return fits ? 'both' : view;
}

/** The pressed half of Edit | Preview; none while both panes show. */
export function switchPressed(layout: Layout, fits: boolean, view: PaneView, single = false): PaneView | undefined {
  const shown = shownPanes(layout, fits, view, single);
  return shown === 'both' ? undefined : shown;
}

const layoutFor = (view: PaneView): Layout => (view === 'edit' ? 'editor' : 'preview');

/**
 * Choosing a half of Edit | Preview. On a narrow screen with editor and
 * preview chosen it only picks the pane shown (as before, not stored);
 * otherwise it switches to that single-pane layout. With the PDF layout (the
 * half reads PDF) it shows that pane alone at any width and keeps the layout,
 * so the switch goes between the text and the PDF.
 */
export function chooseFromSwitch(layout: Layout, fits: boolean, view: PaneView): ViewChange {
  if (layout === 'pdf') return { view, single: true };
  return layout === 'both' && !fits ? { view } : { layout: layoutFor(view) };
}

/**
 * The text/preview toggle (header and Ctrl+Alt+V): text only becomes preview
 * only and back. From side by side it shows the pane other than the one the
 * Edit | Preview switch last chose (the preview, by default).
 */
export function togglePane(layout: Layout, fits: boolean, view: PaneView, single = false): ViewChange {
  const shown = shownPanes(layout, fits, view, single);
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

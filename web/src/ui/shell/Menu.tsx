import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { nextMenuIndex } from '../../shell/menuNav';

// A menu button and its popover, after the WAI-ARIA menu pattern: the button
// has aria-haspopup/aria-expanded, the popover role="menu"; opening focuses
// the first item, arrows/Home/End move, Escape closes and returns focus to
// the button, Tab and a click outside close it. The popover stays in the DOM
// (hidden) so its items are present for tests and server rendering.

const Close = createContext<() => void>(() => undefined);

export interface MenuProps {
  id: string;
  /** Accessible name of the button. */
  label: string;
  buttonClass?: string;
  buttonContent: ComponentChildren;
  tooltip?: string;
  /** Opens above the button (sidebar footer). */
  up?: boolean;
  /** Aligns the popover with the button's left edge instead of its right edge. */
  start?: boolean;
  tour?: string;
  children: ComponentChildren;
}

const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

function items(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return [...menu.querySelectorAll<HTMLElement>(ITEMS)].filter((el) => el.getClientRects().length > 0);
}

const usable = (el: HTMLElement) => el.getAttribute('aria-disabled') !== 'true' && !(el as HTMLButtonElement).disabled;

export function Menu({ id, label, buttonClass, buttonContent, tooltip, up, start, tour, children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    items(menu.current).find(usable)?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (e.key === 'Tab') return setOpen(false);
    const list = items(menu.current);
    const next = nextMenuIndex(e.key, list.indexOf(document.activeElement as HTMLElement), list.map(usable));
    if (next === undefined) return;
    e.preventDefault();
    list[next]?.focus();
  };

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const classes = ['popover', 'menu', up ? 'menu-up' : '', start ? 'menu-start' : ''].filter(Boolean).join(' ');
  return (
    <div class="menu-root" ref={root}>
      <button
        type="button"
        ref={button}
        id={`${id}-button`}
        class={buttonClass}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        data-tooltip={open ? undefined : tooltip}
        data-tour={tour}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKey}
      >
        {buttonContent}
      </button>
      <div id={id} ref={menu} class={classes} role="menu" aria-labelledby={`${id}-button`} hidden={!open} onKeyDown={onKey}>
        <Close.Provider value={() => close()}>{children}</Close.Provider>
      </div>
    </div>
  );
}

/**
 * Header controls that fold into the ⋯ menu as the header narrows (browser
 * zoom, small windows): 'medium' below 70rem of content width, 'small' below
 * 54rem, 'tiny' below 26rem (phones; see styles.css). A folded item is shown in the menu only at those widths.
 */
export type HeaderFold = 'medium' | 'small' | 'tiny';

export interface MenuItemProps {
  onSelect: () => void;
  /** Keyboard shortcut shown on the right, e.g. "Ctrl+Enter". */
  kbd?: string;
  /** Shown on phones only (moved out of the header there). */
  narrowOnly?: boolean;
  /** Shown only once the header has folded the matching control away. */
  fold?: HeaderFold;
  danger?: boolean;
  children: ComponentChildren;
}

export function MenuItem({ onSelect, kbd, narrowOnly, fold, danger, children }: MenuItemProps) {
  const close = useContext(Close);
  const cls = ['menu-item', narrowOnly ? 'narrow-only' : '', fold ? `fold-${fold}` : '', danger ? 'menu-item-danger' : ''].filter(Boolean).join(' ');
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      class={cls}
      onClick={() => {
        close();
        onSelect();
      }}
    >
      <span class="menu-label">{children}</span>
      {kbd && <kbd class="menu-kbd">{kbd}</kbd>}
    </button>
  );
}

export interface MenuRadioProps {
  checked: boolean;
  disabled?: boolean;
  lang?: string;
  title?: string;
  onSelect: () => void;
  children: ComponentChildren;
}

/** One choice of a group; choosing it keeps the menu open so the change is visible. */
export function MenuRadio({ checked, disabled, lang, title, onSelect, children }: MenuRadioProps) {
  return (
    <button
      type="button"
      role="menuitemradio"
      tabIndex={-1}
      class="menu-radio"
      aria-checked={checked}
      aria-disabled={disabled ? 'true' : undefined}
      lang={lang}
      title={title}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      {children}
    </button>
  );
}

export function MenuGroup({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="menu-group" role="group" aria-label={label}>
      <span class="menu-group-label" aria-hidden="true">
        {label}
      </span>
      <div class="menu-segmented">{children}</div>
    </div>
  );
}

export function MenuSeparator() {
  return <div class="menu-separator" role="separator" />;
}

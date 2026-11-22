/**
 * The pin button's menu, with menu-button keyboard behaviour (arrow keys, Home / End, Tab out, focus on open).
 */

'use client';

import React, { useEffect, useRef } from 'react';

/** Where focus goes when the menu opens. */
export type MenuFocus = 'first' | 'last' | 'menu';

interface PinMenuProps {
  id: string;
  label: string;
  /**
   * `first` / `last` for a keyboard open (Enter, Space, ArrowDown, ArrowUp on
   * the pin button). `menu` for a pointer or touch open: the menu itself takes
   * focus, so the arrow keys work, and no item shows a focus ring.
   */
  initialFocus: MenuFocus;
  /** Tab leaves the menu: close it and give focus back to the pin button. */
  onTabOut: () => void;
  error?: string | null;
  children: React.ReactNode;
}

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])';

/** The focusable items inside the menu list, in document order. */
const menuItems = (list: HTMLElement | null): HTMLElement[] =>
  Array.from(list?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);

/**
 * The pin button's menu, following the menu-button pattern: items are out of
 * the tab order; ArrowUp / ArrowDown move through them and wrap, Home / End
 * jump to the ends, Tab closes the menu. Escape is handled by the layer's
 * capture-phase Escape listener.
 */
export default function PinMenu({ id, label, initialFocus, onTabOut, error, children }: PinMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // Only the value at open counts: later renders (a count changing) must not move focus.
  const initialFocusOnOpen = useRef(initialFocus);

  useEffect(() => {
    const list = menuItems(listRef.current);
    const focus = initialFocusOnOpen.current;
    const target = focus === 'first' ? list[0] : focus === 'last' ? list[list.length - 1] : listRef.current;
    target?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      onTabOut();
      return;
    }
    const list = menuItems(listRef.current);
    if (list.length === 0) return;
    const current = list.findIndex((item) => item === document.activeElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % list.length;
    else if (e.key === 'ArrowUp') next = current < 0 ? list.length - 1 : (current - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next === null) return;
    e.preventDefault();
    list[next].focus({ preventScroll: true });
  };

  return (
    <div className="ann-menu">
      {error && (
        <p className="ann-error ann-menu-error" id={`${id}-error`}>
          {error}
        </p>
      )}
      <div
        ref={listRef}
        id={id}
        role="menu"
        aria-label={label}
        aria-describedby={error ? `${id}-error` : undefined}
        tabIndex={-1}
        className="ann-menu-list"
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}

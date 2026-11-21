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

/**
 * The pin button's menu, following the menu-button pattern: items are out of
 * the tab order; ArrowUp / ArrowDown move through them and wrap, Home / End
 * jump to the ends, Tab closes the menu. Escape is handled by the layer's
 * capture-phase Escape listener.
 */
export default function PinMenu({ id, label, initialFocus, onTabOut, error, children }: PinMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []);

  useEffect(() => {
    const list = items();
    const target =
      initialFocus === 'first' ? list[0] : initialFocus === 'last' ? list[list.length - 1] : listRef.current;
    target?.focus({ preventScroll: true });
    // Only on open: later renders (a count changing) must not move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      onTabOut();
      return;
    }
    const list = items();
    if (list.length === 0) return;
    const current = list.indexOf(document.activeElement as HTMLElement);
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

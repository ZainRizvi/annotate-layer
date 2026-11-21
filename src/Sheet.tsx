'use client';

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { CloseIcon } from './icons';
import { readVisualViewport } from './useViewportFrame';
import { isInLayerUI } from './picker';

const SWIPE_CLOSE_PX = 80;
/** At this width and up the sheet is a side panel beside the page, not a modal bottom sheet. */
const SIDE_PANEL_QUERY = '(min-width: 768px)';
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function sidePanelMedia(): MediaQueryList | null {
  try {
    return typeof window.matchMedia === 'function' ? window.matchMedia(SIDE_PANEL_QUERY) : null;
  } catch {
    return null;
  }
}

/**
 * True while the sheet is a bottom sheet over the page (phones): focus stays
 * inside it. The side panel (≥ 768 px) sits beside the page, which stays
 * usable with the keyboard as with the mouse, so it does not trap focus.
 */
function useModalSheet(): boolean {
  const [modal, setModal] = useState(() => !sidePanelMedia()?.matches);
  useEffect(() => {
    const media = sidePanelMedia();
    if (!media) return;
    const onChange = () => setModal(!media.matches);
    onChange();
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);
  return modal;
}

/**
 * Dismissal owned by the layer: Escape and swipe-down go through
 * `requestDismiss`, which asks before discarding a draft.
 */
export interface SheetControl {
  requestDismiss: () => void;
  /** True after a dismiss request was held back to protect a draft. */
  discardPrompt: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

export const SheetControlContext = createContext<SheetControl | null>(null);

interface SheetProps {
  /** Accessible name of the dialog. */
  label: string;
  title: React.ReactNode;
  onClose: () => void;
  /** Disables the close button and swipe-down, e.g. while a save is in flight. */
  closeDisabled?: boolean;
  children: React.ReactNode;
  /** Reports the sheet's top edge so the page can keep the target above it. */
  onTopChange?: (top: number) => void;
}

/**
 * Bottom sheet on phones, right-side panel at ≥ 768 px. On phones it rides on
 * top of the on-screen keyboard by following `visualViewport`, and a swipe
 * down on the grab handle or header closes it.
 */
export default function Sheet({
  label,
  title,
  onClose,
  closeDisabled = false,
  children,
  onTopChange,
}: SheetProps) {
  const control = useContext(SheetControlContext);
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<{ id: number; y: number } | null>(null);
  const onTopChangeRef = useRef(onTopChange);
  useEffect(() => {
    onTopChangeRef.current = onTopChange;
  }, [onTopChange]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const { keyboard, height } = readVisualViewport();
      el.style.setProperty('--ann-kb', `${keyboard}px`);
      el.style.setProperty('--ann-vvh', `${height}px`);
      // The keyboard covers the home indicator, so no safe-area padding then.
      if (keyboard > 0) el.setAttribute('data-keyboard', '');
      else el.removeAttribute('data-keyboard');
      onTopChangeRef.current?.(el.getBoundingClientRect().top);
    };
    apply();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
    resizeObserver?.observe(el);
    return () => {
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      resizeObserver?.disconnect();
    };
  }, []);

  const modal = useModalSheet();
  const closeRef = useRef<HTMLButtonElement>(null);

  // Focus goes back to wherever it was when the sheet opened. Read during
  // the first render: by the time this component's effects run, a child may
  // already have moved focus into the sheet (the new-note textarea).
  const [previous] = useState(() => (typeof document !== 'undefined' ? document.activeElement : null));
  const [openedFromLayer] = useState(() => isInLayerUI(previous));
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      (closeRef.current ?? el).focus({ preventScroll: true });
    }
    return () => {
      if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) {
        previous.focus({ preventScroll: true });
      } else if (openedFromLayer) {
        // The menu item that opened the sheet is gone; the pin button is back.
        document.querySelector<HTMLElement>(`.ann-root .ann-fab`)?.focus({ preventScroll: true });
      }
    };
  }, [previous, openedFromLayer]);

  // Tab and Shift-Tab cycle through the sheet's controls while it is modal.
  useEffect(() => {
    if (!modal) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key !== 'Tab' || !el) return;
      const focusable = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => !node.closest('[hidden]')
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      let next: HTMLElement | null = null;
      if (!first) next = el;
      else if (!el.contains(active)) next = e.shiftKey ? last : first;
      else if (e.shiftKey && (active === first || active === el)) next = last;
      else if (!e.shiftKey && active === last) next = first;
      if (next) {
        e.preventDefault();
        next.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [modal]);

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('button, a')) return;
    dragStart.current = { id: e.pointerId, y: e.clientY };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragStart.current?.id !== e.pointerId) return;
    setDrag(Math.max(0, e.clientY - dragStart.current.y));
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    if (dragStart.current?.id !== e.pointerId) return;
    const distance = e.clientY - dragStart.current.y;
    dragStart.current = null;
    setDrag(0);
    if (distance > SWIPE_CLOSE_PX && !closeDisabled) (control ? control.requestDismiss : onClose)();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      aria-modal={modal}
      tabIndex={-1}
      className="ann-sheet"
      data-dragging={drag > 0 ? '' : undefined}
      style={drag > 0 ? { transform: `translateY(${drag}px)` } : undefined}
    >
      <div
        className="ann-sheet-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <span className="ann-grab" aria-hidden="true" />
        <div className="ann-sheet-title">{title}</div>
        <button
          ref={closeRef}
          type="button"
          className="ann-icon-btn"
          // Through the layer's guard, like Escape and swipe-down: a note
          // with text or marks asks before it is discarded.
          onClick={control ? control.requestDismiss : onClose}
          disabled={closeDisabled}
          aria-label="Close"
        >
          <CloseIcon size={18} />
        </button>
      </div>
      <div className="ann-sheet-body">
        {control?.discardPrompt && (
          <div className="ann-discard" role="alert">
            <span>Discard note?</span>
            <div className="ann-actions">
              <button type="button" className="ann-btn" onClick={control.onKeepEditing}>
                Keep editing
              </button>
              <button type="button" className="ann-btn ann-btn-danger" onClick={control.onDiscard}>
                Discard
              </button>
            </div>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * Hook that handles Escape for the layer in the capture phase, ahead of the app's own handlers.
 */

'use client';

import { useEffect, useRef } from 'react';

/**
 * Escape for the layer, handled in the capture phase and stopped there so the
 * app's own Escape handlers (modals close via `history.back()`) never run.
 */
export function useLayerEscape(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onEscapeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);
}

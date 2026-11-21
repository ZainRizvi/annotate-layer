'use client';

import { useEffect, useRef } from 'react';
import { isInLayerUI } from './picker';
import type { StrokeSink } from './useLongPress';

type PickHandler = (target: Element, input: 'touch' | 'pointer') => void;

function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

/**
 * "Tap anything" mode. While armed, the next tap or click outside the layer UI
 * picks its target instead of activating it: pointerdown is cancelled so
 * fields do not focus, and the click is cancelled so links and buttons do not
 * fire. Scrolling still works.
 */
export function useTapToPick(armed: boolean, onPick: PickHandler): void {
  const onPickRef = useLatest(onPick);

  useEffect(() => {
    if (!armed) return;
    let lastPointerType: 'touch' | 'pointer' = 'pointer';

    const block = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target || isInLayerUI(target)) return null;
      e.preventDefault();
      e.stopPropagation();
      return target;
    };

    const onPointerDown = (e: PointerEvent) => {
      lastPointerType = e.pointerType === 'touch' || e.pointerType === 'pen' ? 'touch' : 'pointer';
      block(e);
    };
    const onClick = (e: MouseEvent) => {
      const target = block(e);
      if (target) onPickRef.current(target, lastPointerType);
    };

    const capture = { capture: true } as const;
    document.addEventListener('pointerdown', onPointerDown, capture);
    document.addEventListener('mousedown', block, capture);
    document.addEventListener('click', onClick, capture);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, capture);
      document.removeEventListener('mousedown', block, capture);
      document.removeEventListener('click', onClick, capture);
    };
  }, [armed, onPickRef]);
}

function isMacLike(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** Mouse travel with ⌘ held that turns a press into a pen stroke. */
export const DRAG_STROKE_PX = 6;

/**
 * A ⌘-press that may become a stroke, followed until the button comes up.
 * Independent of the hook's listeners, which detach once draw mode starts.
 * After a stroke the click the release produces is swallowed (on `window`,
 * ahead of every document listener), so it neither picks nor opens a link.
 */
function trackModifierDrag(start: MouseEvent, sink: () => StrokeSink | undefined, onStrokeStart: () => void) {
  const origin: [number, number] = [start.clientX, start.clientY];
  let stroking = false;
  const capture = { capture: true } as const;

  const onMove = (e: MouseEvent) => {
    const point: [number, number] = [e.clientX, e.clientY];
    if (stroking) {
      sink()?.extend(point);
      return;
    }
    if (Math.hypot(point[0] - origin[0], point[1] - origin[1]) < DRAG_STROKE_PX) return;
    const target = sink();
    if (!target) return;
    stroking = true;
    onStrokeStart();
    target.begin([origin, point], 'pointer');
  };
  const swallowClick = (e: MouseEvent) => {
    window.removeEventListener('click', swallowClick, capture);
    e.preventDefault();
    e.stopPropagation();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove, capture);
    document.removeEventListener('mouseup', onUp, capture);
    window.removeEventListener('blur', onUp);
    if (!stroking) return;
    sink()?.end();
    window.addEventListener('click', swallowClick, capture);
    // No click follows when the button came up over another element.
    window.setTimeout(() => window.removeEventListener('click', swallowClick, capture), 0);
  };
  document.addEventListener('mousemove', onMove, capture);
  document.addEventListener('mouseup', onUp, capture);
  window.addEventListener('blur', onUp);
}

/**
 * Desktop ⌘-click (Ctrl-click off Apple platforms) picks; ⌘-drag draws a
 * stroke into `stroke`. Holding the modifier reports the hovered element so
 * the layer can outline it. A ⌘-press never starts a text selection.
 */
export function useModifierPick(
  enabled: boolean,
  onPick: PickHandler,
  onHover: (target: Element | null) => void,
  stroke?: StrokeSink
): void {
  const onPickRef = useLatest(onPick);
  const onHoverRef = useLatest(onHover);
  const strokeRef = useLatest(stroke);

  useEffect(() => {
    if (!enabled) return;
    const mac = isMacLike();
    const modifierKey = mac ? 'Meta' : 'Control';
    const held = (e: MouseEvent | KeyboardEvent) => (mac ? e.metaKey : e.ctrlKey);
    let lastTarget: Element | null = null;

    const setHover = (target: Element | null) => {
      const next = target && !isInLayerUI(target) ? target : null;
      if (next !== lastTarget) {
        lastTarget = next;
        onHoverRef.current(next);
      }
    };

    const release = () => setHover(null);
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === modifierKey) release();
    };
    const onMouseMove = (e: MouseEvent) => {
      setHover(held(e) && e.target instanceof Element ? e.target : null);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!held(e) || e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || isInLayerUI(target)) return;
      // No text selection or native drag; the click that follows still picks.
      e.preventDefault();
      trackModifierDrag(e, () => strokeRef.current, release);
    };
    const onClick = (e: MouseEvent) => {
      if (!held(e)) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || isInLayerUI(target)) return;
      e.preventDefault();
      e.stopPropagation();
      release();
      onPickRef.current(target, 'pointer');
    };

    const capture = { capture: true } as const;
    window.addEventListener('keyup', onKeyUp, capture);
    window.addEventListener('blur', release);
    document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
    document.addEventListener('mousedown', onMouseDown, capture);
    document.addEventListener('click', onClick, capture);
    return () => {
      setHover(null);
      window.removeEventListener('keyup', onKeyUp, capture);
      window.removeEventListener('blur', release);
      document.removeEventListener('mousemove', onMouseMove, { capture: true });
      document.removeEventListener('mousedown', onMouseDown, capture);
      document.removeEventListener('click', onClick, capture);
    };
  }, [enabled, onPickRef, onHoverRef, strokeRef]);
}

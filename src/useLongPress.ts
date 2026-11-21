'use client';

import { useEffect, useRef } from 'react';
import { isEditable, isInLayerUI } from './picker';
import type { Point } from './drawing';

export const LONG_PRESS_MS = 450;
/** After this long still, `ann-pressing` stops iOS selection, loupe and callout. */
export const PRESSING_CLASS_MS = 200;
export const MOVE_TOLERANCE_PX = 10;
/** How long after release the release's own click may still arrive. */
const SWALLOW_AFTER_RELEASE_MS = 300;
/** Ends a fired press whose release never arrives; every move restarts it. */
const BACKSTOP_MS = 10_000;
export const PRESSING_CLASS = 'ann-pressing';

/** Receives a gesture that turned into a pen stroke, in viewport pixels. */
export interface StrokeSink {
  begin(points: Point[], input: 'touch' | 'pointer'): void;
  extend(point: Point): void;
  end(): void;
  /** Drop the stroke in progress (a second finger turned it into a pinch). */
  cancel?(): void;
}

interface Callbacks {
  /** The press fired and the finger is still down: the element is about to be picked. */
  onArm?: (target: Element) => void;
  /** A fired press ended without a pick or a stroke. */
  onDisarm?: () => void;
  /** The finger lifted after the press fired, without drawing. */
  onLongPress: (target: Element, point: { x: number; y: number }) => void;
  /** Moving after the press fired draws here instead of picking. */
  stroke?: StrokeSink;
}

interface LongPressOptions extends Callbacks {
  /** Listeners are attached only while true. */
  enabled: boolean;
}

/**
 * The rest of a press once it has fired, until the finger lifts. Independent
 * of the hook's listeners: the layer may turn long-press off (draw mode
 * starts) while the finger is still down.
 *
 * - Keeps `ann-pressing` on until release (iOS would start a selection).
 * - Leaves the touchmove blocker on, so the page cannot scroll under the finger.
 * - Moving more than MOVE_TOLERANCE_PX from where the press started turns it
 *   into a pen stroke; lifting without that picks the pressed element.
 * - A second finger (a pinch) cancels it: scrolling and zooming are released
 *   at once, nothing is picked, and a stroke in progress is dropped.
 * - Swallows the contextmenu and the click the release produces on the
 *   pressed element (or an ancestor of it). The first click ends that window
 *   either way, so a tap on the new sheet still works.
 */
function trackAfterFire(
  pointerId: number,
  pressed: Element,
  start: Point,
  callbacks: () => Callbacks,
  unblockScroll: () => void
): void {
  const root = document.documentElement;
  const capture = { capture: true } as const;
  const passiveCapture = { capture: true, passive: true } as const;
  let backstop = 0;
  let swallowTimer = 0;
  let stroking = false;
  let moved = false;
  let released = false;

  const restartBackstop = () => {
    window.clearTimeout(backstop);
    backstop = window.setTimeout(() => release(false), BACKSTOP_MS);
  };

  const stopSwallowing = () => {
    window.clearTimeout(swallowTimer);
    document.removeEventListener('click', swallow, capture);
    document.removeEventListener('contextmenu', swallow, capture);
  };

  function swallow(e: Event) {
    // The release click targets the pressed element, a child of it, or (when
    // the finger drifted onto a sibling) an ancestor both share, such as a link.
    const target = e.target instanceof Node ? e.target : null;
    const onPressed = !!target && (pressed.contains(target) || target.contains(pressed));
    if (e.type === 'click') {
      stopSwallowing();
      if (!onPressed) return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function stopTracking() {
    released = true;
    window.clearTimeout(backstop);
    root.classList.remove(PRESSING_CLASS);
    unblockScroll();
    document.removeEventListener('pointermove', onMove, capture);
    document.removeEventListener('pointerup', onUp, capture);
    document.removeEventListener('pointercancel', onCancel, capture);
    document.removeEventListener('pointerdown', onOtherPointer, capture);
    document.removeEventListener('touchstart', onTouchStart, passiveCapture);
    swallowTimer = window.setTimeout(stopSwallowing, SWALLOW_AFTER_RELEASE_MS);
  }

  function release(pick: boolean) {
    if (released) return;
    stopTracking();
    const { onLongPress, onDisarm, stroke } = callbacks();
    if (stroking) stroke?.end();
    else if (pick) onLongPress(pressed, { x: start[0], y: start[1] });
    else onDisarm?.();
  }

  /** A second finger: this is a pinch or a two-finger scroll, not an annotation. */
  function abandon() {
    if (released) return;
    stopTracking();
    const { onDisarm, stroke } = callbacks();
    if (stroking) stroke?.cancel?.();
    onDisarm?.();
  }
  function onOtherPointer(e: PointerEvent) {
    if (e.pointerType === 'touch' && e.pointerId !== pointerId) abandon();
  }
  function onTouchStart(e: TouchEvent) {
    if (e.touches.length > 1) abandon();
  }

  function onMove(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    restartBackstop();
    const point: Point = [e.clientX, e.clientY];
    const { stroke } = callbacks();
    if (stroking) {
      stroke?.extend(point);
      return;
    }
    if (Math.hypot(point[0] - start[0], point[1] - start[1]) <= MOVE_TOLERANCE_PX) return;
    moved = true;
    if (stroke) {
      stroking = true;
      stroke.begin([start, point], 'touch');
    }
  }
  function onUp(e: PointerEvent) {
    if (e.pointerId === pointerId) release(!moved);
  }
  // A still finger whose touch the browser cancels (a system gesture) still
  // picks: the long-press had already fired.
  function onCancel(e: PointerEvent) {
    if (e.pointerId === pointerId) release(!moved);
  }

  restartBackstop();
  document.addEventListener('pointerdown', onOtherPointer, capture);
  document.addEventListener('touchstart', onTouchStart, passiveCapture);
  document.addEventListener('pointermove', onMove, capture);
  document.addEventListener('pointerup', onUp, capture);
  document.addEventListener('pointercancel', onCancel, capture);
  document.addEventListener('click', swallow, capture);
  document.addEventListener('contextmenu', swallow, capture);
}

/**
 * Document-wide touch long-press. Fires after a still 450 ms press on any
 * element outside inputs, editable regions and the layer's own UI. Movement
 * over 10 px, release, pointercancel, a second finger (a pinch) or any scroll
 * before then cancels it.
 *
 * Once fired, lifting the finger picks the element and moving it draws a
 * stroke (see `trackAfterFire`). Each press attaches a non-passive
 * `touchmove` listener for its own length; it calls `preventDefault` only
 * after the press has fired, so ordinary scrolling is never blocked.
 */
export function useLongPress({ enabled, ...callbacks }: LongPressOptions): void {
  const callbacksRef = useRef<Callbacks>(callbacks);
  useEffect(() => {
    callbacksRef.current = callbacks;
  });

  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const blocking = { capture: true, passive: false } as const;

    let press: {
      pointerId: number;
      x: number;
      y: number;
      target: Element;
      pressingTimer: number;
      fireTimer: number;
      blockTouchMove: (e: TouchEvent) => void;
    } | null = null;

    /** Ends a press that has not fired. */
    const endPress = () => {
      if (!press) return;
      window.clearTimeout(press.pressingTimer);
      window.clearTimeout(press.fireTimer);
      document.removeEventListener('touchmove', press.blockTouchMove, blocking);
      press = null;
      root.classList.remove(PRESSING_CLASS);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      // A second finger before the press fires: a pinch, not a long-press.
      if (!e.isPrimary || (press && e.pointerId !== press.pointerId)) {
        endPress();
        return;
      }
      endPress();
      const target = e.target instanceof Element ? e.target : null;
      if (!target || isEditable(target) || isInLayerUI(target)) return;
      let fired = false;
      const blockTouchMove = (te: TouchEvent) => {
        if (fired && te.cancelable) te.preventDefault();
      };
      const fire = () => {
        if (!press) return;
        const { pointerId, x, y } = press;
        window.clearTimeout(press.pressingTimer);
        press = null;
        fired = true;
        root.classList.add(PRESSING_CLASS);
        trackAfterFire(pointerId, target, [x, y], () => callbacksRef.current, () =>
          document.removeEventListener('touchmove', blockTouchMove, blocking)
        );
        try {
          navigator.vibrate?.(8);
        } catch {
          // Vibration is optional; some browsers throw without a user gesture.
        }
        window.getSelection()?.removeAllRanges();
        callbacksRef.current.onArm?.(target);
      };
      document.addEventListener('touchmove', blockTouchMove, blocking);
      press = {
        pointerId: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        target,
        pressingTimer: window.setTimeout(() => root.classList.add(PRESSING_CLASS), PRESSING_CLASS_MS),
        fireTimer: window.setTimeout(fire, LONG_PRESS_MS),
        blockTouchMove,
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!press || e.pointerId !== press.pointerId) return;
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE_PX) endPress();
    };

    const onPointerUp = (e: PointerEvent) => {
      if (press && e.pointerId === press.pointerId) endPress();
    };

    // Android opens its context menu on long-press; keep it shut once the
    // press is clearly a long-press in progress.
    const onContextMenu = (e: Event) => {
      if (press && root.classList.contains(PRESSING_CLASS)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 1) endPress();
    };

    const capture = { capture: true } as const;
    const passiveCapture = { capture: true, passive: true } as const;
    document.addEventListener('pointerdown', onPointerDown, passiveCapture);
    document.addEventListener('touchstart', onTouchStart, passiveCapture);
    document.addEventListener('pointermove', onPointerMove, passiveCapture);
    document.addEventListener('pointerup', onPointerUp, passiveCapture);
    document.addEventListener('pointercancel', onPointerUp, passiveCapture);
    document.addEventListener('scroll', endPress, passiveCapture);
    document.addEventListener('contextmenu', onContextMenu, capture);

    return () => {
      endPress();
      document.removeEventListener('pointerdown', onPointerDown, passiveCapture);
      document.removeEventListener('touchstart', onTouchStart, passiveCapture);
      document.removeEventListener('pointermove', onPointerMove, passiveCapture);
      document.removeEventListener('pointerup', onPointerUp, passiveCapture);
      document.removeEventListener('pointercancel', onPointerUp, passiveCapture);
      document.removeEventListener('scroll', endPress, passiveCapture);
      document.removeEventListener('contextmenu', onContextMenu, capture);
    };
  }, [enabled]);
}

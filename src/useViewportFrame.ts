'use client';

import { useEffect, useRef, useState } from 'react';
import { isInLayerUI } from './picker';

/**
 * Re-measure overlays at most once per animation frame, only when something
 * moved: the page scrolled or resized, the keyboard moved the visual viewport,
 * the DOM changed (streaming text, a drawer opening), or a CSS transition
 * or animation finished (the sidebar's slide, a modal's zoom), so pins settle
 * on an element's final position rather than where it started. No timers run,
 * so an idle page costs nothing, and nothing is scheduled while the tab is
 * hidden.
 *
 * `onFrame` runs on every scheduled frame. The returned tick only advances
 * (re-rendering the caller) while `active`, i.e. while overlays are on screen.
 */
export function useViewportFrame(active: boolean, onFrame?: () => void): number {
  const [tick, setTick] = useState(0);
  const activeRef = useRef(active);
  const onFrameRef = useRef(onFrame);
  const scheduleRef = useRef<() => void>(() => {});
  useEffect(() => {
    activeRef.current = active;
    onFrameRef.current = onFrame;
  });

  useEffect(() => {
    let frame = 0;
    const run = () => {
      frame = 0;
      onFrameRef.current?.();
      if (activeRef.current) setTick((t) => t + 1);
    };
    const schedule = () => {
      if (frame || document.hidden) return;
      frame = window.requestAnimationFrame(run);
    };
    scheduleRef.current = schedule;

    const vv = window.visualViewport;
    const opts = { capture: true, passive: true } as const;
    document.addEventListener('scroll', schedule, opts);
    window.addEventListener('resize', schedule);
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    document.addEventListener('visibilitychange', schedule);
    const onMotionEnd = (e: Event) => {
      if (!isInLayerUI(e.target instanceof Element ? e.target : null)) schedule();
    };
    document.addEventListener('transitionend', onMotionEnd, opts);
    document.addEventListener('animationend', onMotionEnd, opts);
    const observer = new MutationObserver((records) => {
      const pageChanged = records.some(
        (r) => !isInLayerUI(r.target instanceof Element ? r.target : r.target.parentElement)
      );
      if (pageChanged) schedule();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open'],
    });
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scheduleRef.current = () => {};
      observer.disconnect();
      document.removeEventListener('scroll', schedule, opts);
      window.removeEventListener('resize', schedule);
      vv?.removeEventListener('resize', schedule);
      vv?.removeEventListener('scroll', schedule);
      document.removeEventListener('visibilitychange', schedule);
      document.removeEventListener('transitionend', onMotionEnd, opts);
      document.removeEventListener('animationend', onMotionEnd, opts);
    };
  }, []);

  // Measure straight away when overlays appear.
  useEffect(() => {
    if (active) scheduleRef.current();
  }, [active]);

  return tick;
}

/** Keyboard height and visible height from `visualViewport`. */
export function readVisualViewport(): { keyboard: number; height: number } {
  const vv = window.visualViewport;
  if (!vv) return { keyboard: 0, height: window.innerHeight };
  const keyboard = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  return { keyboard, height: Math.round(vv.height) };
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

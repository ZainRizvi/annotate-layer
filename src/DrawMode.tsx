'use client';

import React, { useEffect, useRef } from 'react';
import Marks from './Marks';
import type { PixelStroke } from './drawing';
import type { StrokeSink } from './useLongPress';

interface DrawModeProps {
  /** Finished strokes, then the one being drawn. */
  strokes: PixelStroke[];
  live: PixelStroke | null;
  sink: StrokeSink;
  onUndo: () => void;
  onClear: () => void;
  onCancel: () => void;
  onDone: () => void;
  /** Opened from the keyboard (the pin menu): focus the toolbar's first usable button. */
  autoFocus?: boolean;
}

/**
 * Draw mode: a transparent surface over the whole viewport takes every touch
 * and mouse press as a pen stroke (`touch-action: none`, wheel blocked, so the
 * page stays where it is under the marks), and a toolbar finishes or
 * abandons the drawing.
 */
export default function DrawMode({ strokes, live, sink, onUndo, onClear, onCancel, onDone, autoFocus }: DrawModeProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) barRef.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus({ preventScroll: true });
    // Only when draw mode opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const activePointer = useRef<number | null>(null);

  // React's wheel listener is passive; this one may cancel the scroll.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const block = (e: Event) => e.preventDefault();
    el.addEventListener('wheel', block, { passive: false });
    return () => el.removeEventListener('wheel', block);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    activePointer.current = e.pointerId;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    sink.begin([[e.clientX, e.clientY]], e.pointerType === 'mouse' ? 'pointer' : 'touch');
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (activePointer.current !== e.pointerId) return;
    sink.extend([e.clientX, e.clientY]);
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    if (activePointer.current !== e.pointerId) return;
    activePointer.current = null;
    sink.end();
  };

  const all = live ? [...strokes, live] : strokes;
  const empty = strokes.length === 0;

  return (
    <div className="ann-draw">
      <div
        ref={surfaceRef}
        className="ann-draw-surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      />
      <Marks strokes={all} />
      <div ref={barRef} className="ann-draw-bar" role="toolbar" aria-label="Drawing">
        <button type="button" className="ann-btn" onClick={onUndo} disabled={empty}>
          Undo
        </button>
        <button type="button" className="ann-btn" onClick={onClear} disabled={empty}>
          Clear
        </button>
        <button type="button" className="ann-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="ann-btn ann-btn-primary" onClick={onDone} disabled={empty}>
          Done
        </button>
      </div>
    </div>
  );
}

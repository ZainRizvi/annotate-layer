'use client';

import React from 'react';
import { strokePath, type PixelStroke } from './drawing';

interface MarksProps {
  /** Strokes in viewport pixels. */
  strokes: ReadonlyArray<PixelStroke>;
  className?: string;
}

/**
 * Pen strokes drawn over the page: a full-viewport SVG that lets every
 * pointer event through.
 */
export default function Marks({ strokes, className = 'ann-marks' }: MarksProps) {
  if (strokes.length === 0) return null;
  return (
    <svg className={className} aria-hidden="true" focusable="false">
      {strokes.map((stroke, i) => (
        <path key={i} d={strokePath(stroke)} className="ann-mark-stroke" />
      ))}
    </svg>
  );
}

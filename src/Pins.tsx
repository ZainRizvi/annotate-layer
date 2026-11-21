'use client';

import React, { useEffect } from 'react';
import type { AnnotationItem, AnnotationStatus } from './types';
import type { AnchorMap } from './useAnchoredNotes';
import { pageElementAt } from './picker';
import { STATUS_LABELS } from './NotesSheets';

/** Pin fill per status: blue open, amber working, green done. */
export const STATUS_COLORS: Record<AnnotationStatus, string> = {
  open: 'rgb(var(--_ann-open))',
  working: 'rgb(var(--_ann-working))',
  done: 'rgb(var(--_ann-done))',
};

const EDGE_MARGIN = 10;
/** Sub-pixel overflow at the screen edge still counts as on screen. */
const EDGE_SLACK = 2;
/** How far inside the corner to probe for something covering the element. */
const PROBE_INSET = 24;

/**
 * False when another element (an open modal, a header) sits over the
 * element's top corner. The layer's own UI is looked through: on a small
 * target such as a citation chip the pin itself covers the probe point.
 */
function cornerVisible(el: Element, rect: DOMRect, rtl: boolean): boolean {
  const dx = Math.min(PROBE_INSET, rect.width / 2);
  const dy = Math.min(PROBE_INSET, rect.height / 2);
  const x = rtl ? rect.left + dx : rect.right - dx;
  const hit = pageElementAt(x, rect.top + dy);
  // Unknown (no elementsFromPoint) or nothing at all: keep the pin.
  if (!hit) return true;
  return el.contains(hit);
}

/** Tap target of one pin (the `.ann-pin` box), and the gap between fanned pins. */
export const PIN_SIZE = 44;
export const PIN_GAP = 4;
/** Pins one element shows at most; with more notes the last slot is a "+N" pin. */
export const MAX_PINS_PER_ELEMENT = 3;

/** Working notes first, then open, then done: the ones still to act on get their own pins. */
const STATUS_ORDER: Record<AnnotationStatus, number> = { working: 0, open: 1, done: 2 };

interface PinsProps {
  notes: AnnotationItem[];
  anchors: AnchorMap;
  /** Changes every frame the page moves, so positions are re-read. */
  frame: number;
  onOpen: (note: AnnotationItem) => void;
  /** The "+N" pin: every note on one element, in pin order. */
  onOpenGroup: (notes: AnnotationItem[]) => void;
  /** After each render: the notes that got a pin of their own on screen. */
  onShown?: (notes: AnnotationItem[]) => void;
}

/** Notes grouped by the element they resolve to, in first-seen order. */
function byElement(notes: AnnotationItem[], anchors: AnchorMap): Array<[Element, AnnotationItem[]]> {
  const groups = new Map<Element, AnnotationItem[]>();
  for (const note of notes) {
    const el = anchors.get(note.number);
    if (!el || !el.isConnected) continue;
    const group = groups.get(el);
    if (group) group.push(note);
    else groups.set(el, [note]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  }
  return Array.from(groups.entries());
}

/**
 * Markers at the top-end corner of each anchored element (top-left for
 * right-to-left content). Notes whose element is gone get no pin; the list
 * shows them as moved.
 *
 * Several notes on one element fan out from the corner toward the inline
 * start, one 44 px tap target each, 4 px apart, so none covers another. With
 * more than MAX_PINS_PER_ELEMENT notes, the first two keep their pins and a
 * "+N" pin opens the notes list for that element. The row is shifted as a
 * whole to stay on screen.
 */
export default function Pins({ notes, anchors, frame, onOpen, onOpenGroup, onShown }: PinsProps) {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
  const pitch = PIN_SIZE + PIN_GAP;
  const shownNotes: AnnotationItem[] = [];

  const rows = byElement(notes, anchors).flatMap(([el, group]) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return [];
    const rtl = getComputedStyle(el).direction === 'rtl';
    const cornerX = rtl ? rect.left : rect.right;
    // The pin sits on the top corner; once that corner leaves the screen
    // (scrolled away, or a closed drawer translated off to the side) the
    // pin goes with it rather than sticking to the screen edge.
    if (rect.top < 0 || rect.top > vh || cornerX < -EDGE_SLACK || cornerX > vw + EDGE_SLACK) return [];
    if (rect.right <= EDGE_SLACK || rect.left >= vw - EDGE_SLACK) return [];
    if (!cornerVisible(el, rect, rtl)) return [];

    const overflow = group.length > MAX_PINS_PER_ELEMENT;
    const shown = overflow ? group.slice(0, MAX_PINS_PER_ELEMENT - 1) : group;
    const slots = shown.length + (overflow ? 1 : 0);
    shownNotes.push(...shown);
    // Toward the inline start: left in LTR, right in RTL.
    const step = rtl ? pitch : -pitch;
    let x0 = Math.min(Math.max(cornerX, EDGE_MARGIN), vw - EDGE_MARGIN);
    const far = x0 + step * (slots - 1);
    if (far < EDGE_MARGIN) x0 += EDGE_MARGIN - far;
    if (far > vw - EDGE_MARGIN) x0 -= far - (vw - EDGE_MARGIN);
    const y = Math.max(rect.top, EDGE_MARGIN);

    const pins = shown.map((note, i) => (
      <button
        key={note.number}
        type="button"
        className="ann-pin"
        data-status={note.status}
        style={{ left: x0 + step * i, top: y, ['--ann-pin' as string]: STATUS_COLORS[note.status] }}
        aria-label={`Note #${note.number}, ${STATUS_LABELS[note.status]}`}
        onClick={() => onOpen(note)}
      >
        <span className="ann-pin-dot" aria-hidden="true" />
      </button>
    ));
    if (overflow) {
      const more = group.length - shown.length;
      pins.push(
        <button
          key={`more-${group[0].number}`}
          type="button"
          className="ann-pin ann-pin-more"
          style={{ left: x0 + step * shown.length, top: y }}
          aria-label={`${more} more notes here`}
          onClick={() => onOpenGroup(group)}
        >
          <span className="ann-pin-more-label" aria-hidden="true">
            +{more}
          </span>
        </button>
      );
    }
    return pins;
  });

  // No dependency list: positions change every frame, so every render reports.
  useEffect(() => {
    onShown?.(shownNotes);
  });

  return (
    <div className="ann-pins" data-frame={frame}>
      {rows}
    </div>
  );
}

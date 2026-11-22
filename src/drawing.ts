/**
 * Pen stroke geometry: simplifying and limiting strokes, converting between viewport pixels and element-relative coordinates, bounds, and SVG paths.
 */

import type { AnnotationDrawing, AnnotationRect, AnnotationStroke } from './types';

/** A point in viewport CSS pixels. */
export type Point = [number, number];
/** A stroke in viewport CSS pixels, as drawn. */
export type PixelStroke = Point[];

/** Ramer–Douglas–Peucker tolerance for a finished stroke, in CSS pixels. */
export const SIMPLIFY_PX = 1.5;
export const MAX_STROKES = 30;
export const MAX_POINTS_PER_STROKE = 400;
export const MAX_POINTS_TOTAL = 1500;
/** Element-relative coordinates are clamped to this range (0..1 is inside the element). */
export const COORD_LIMIT = 10;

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Ramer–Douglas–Peucker: drop points closer than `epsilon` to the line
 * through their neighbours. Iterative, so long strokes cannot overflow the
 * stack. A one-point stroke (a dot) becomes two equal points.
 */
export function simplifyStroke(points: PixelStroke, epsilon = SIMPLIFY_PX): PixelStroke {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0], points[0]];
  if (points.length === 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  for (let range = stack.pop(); range; range = stack.pop()) {
    const [first, last] = range;
    let index = -1;
    let max = 0;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(points[i], points[first], points[last]);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index !== -1 && max > epsilon) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** One stroke at no more than `max` points: simplify harder until it fits. */
function fitStroke(points: PixelStroke, max: number): PixelStroke {
  let stroke = points;
  let epsilon = SIMPLIFY_PX;
  while (stroke.length > max && epsilon < 4096) {
    epsilon *= 2;
    stroke = simplifyStroke(points, epsilon);
  }
  if (stroke.length <= max) return stroke;
  // A pathological stroke (thousands of far-apart points): sample evenly.
  const step = (stroke.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => stroke[Math.round(i * step)]);
}

/**
 * Strokes within the storage limits: each stroke fits in
 * MAX_POINTS_PER_STROKE (simplified further if needed), and strokes past
 * MAX_STROKES or MAX_POINTS_TOTAL are left out. `dropped` counts those.
 */
export function limitStrokes(strokes: PixelStroke[]): { strokes: PixelStroke[]; dropped: number } {
  const kept: PixelStroke[] = [];
  let total = 0;
  let dropped = 0;
  for (const raw of strokes) {
    if (raw.length === 0) continue;
    const stroke = fitStroke(raw, MAX_POINTS_PER_STROKE);
    if (kept.length >= MAX_STROKES || total + stroke.length > MAX_POINTS_TOTAL) {
      dropped += 1;
      continue;
    }
    kept.push(stroke);
    total += stroke.length;
  }
  return { strokes: kept, dropped };
}

/** Bounding box of the strokes in their own coordinates; `null` when there are none. */
export function strokesBounds(strokes: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): AnnotationRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const [x, y] of stroke) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

const round3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r; // no -0 in the JSON
};
const clampCoord = (v: number) => round3(Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v)));

/**
 * Strokes relative to `rect` (the anchor element's viewport rect): 0..1 is
 * inside it. Rounded to 3 decimals and clamped to ±COORD_LIMIT.
 */
export function normalizeDrawing(strokes: PixelStroke[], rect: AnnotationRect): AnnotationDrawing {
  // A zero-size element still gets finite coordinates.
  const w = rect.w || 1;
  const h = rect.h || 1;
  const relative: AnnotationStroke[] = strokes.map((stroke) =>
    stroke.map(([x, y]): Point => [clampCoord((x - rect.x) / w), clampCoord((y - rect.y) / h)])
  );
  const bounds = strokesBounds(relative) ?? { x: 0, y: 0, w: 0, h: 0 };
  return {
    strokes: relative,
    bbox: { x: round3(bounds.x), y: round3(bounds.y), w: round3(bounds.w), h: round3(bounds.h) },
  };
}

/** A stored drawing in viewport pixels for the element's current rect. */
export function drawingToPixels(drawing: AnnotationDrawing, rect: AnnotationRect): PixelStroke[] {
  return drawing.strokes.map((stroke) =>
    stroke.map(([x, y]): Point => [rect.x + x * rect.w, rect.y + y * rect.h])
  );
}

/** Whether a value from the server looks like a drawing the layer can render. */
export function isDrawing(value: unknown): value is AnnotationDrawing {
  if (!value || typeof value !== 'object' || !('strokes' in value)) return false;
  const { strokes } = value;
  return (
    Array.isArray(strokes) &&
    strokes.every(
      (s) =>
        Array.isArray(s) &&
        s.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    )
  );
}

/** SVG path data for a pixel stroke; a dot becomes a zero-length segment that round caps draw as a disc. */
export function strokePath(stroke: ReadonlyArray<readonly [number, number]>): string {
  if (stroke.length === 0) return '';
  const [first, ...rest] = stroke;
  const tail = rest.length ? rest : [first];
  return `M${first[0].toFixed(1)} ${first[1].toFixed(1)}` + tail.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join('');
}

/** Pixel strokes drawn against `from`, moved and scaled to follow that element to `to`. */
export function reprojectStrokes(strokes: PixelStroke[], from: AnnotationRect, to: AnnotationRect): PixelStroke[] {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  return strokes.map((stroke) =>
    stroke.map(([x, y]): Point => [to.x + (x - from.x) * sx, to.y + (y - from.y) * sy])
  );
}

export function rectOf(el: Element): AnnotationRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

import { describe, it, expect } from 'vitest';
import {
  drawingToPixels,
  limitStrokes,
  MAX_POINTS_PER_STROKE,
  MAX_POINTS_TOTAL,
  MAX_STROKES,
  normalizeDrawing,
  simplifyStroke,
  type PixelStroke,
} from '../src/drawing';

/** A stroke RDP cannot shorten: every point is 10 px off its neighbours' line. */
const zigzag = (n: number, x0 = 0): PixelStroke =>
  Array.from({ length: n }, (_, i) => [x0 + i, i % 2 ? 10 : 0] as [number, number]);

describe('simplifyStroke', () => {
  it('drops points within 1.5 px of the line and keeps corners', () => {
    const stroke: PixelStroke = [[0, 0], [5, 0.5], [10, 1], [10, 10], [10.4, 20]];
    expect(simplifyStroke(stroke)).toEqual([[0, 0], [10, 1], [10.4, 20]]);
  });

  it('turns a tap into a dot of two equal points', () => {
    expect(simplifyStroke([[4, 4]])).toEqual([[4, 4], [4, 4]]);
  });
});

describe('limitStrokes', () => {
  it('keeps at most 30 strokes and counts the rest', () => {
    const strokes = Array.from({ length: MAX_STROKES + 3 }, (_, i): PixelStroke => [[i, 0], [i, 5]]);
    const { strokes: kept, dropped } = limitStrokes(strokes);
    expect(kept).toHaveLength(MAX_STROKES);
    expect(dropped).toBe(3);
  });

  it('simplifies a stroke past 400 points until it fits', () => {
    const { strokes, dropped } = limitStrokes([zigzag(1000)]);
    expect(strokes[0].length).toBeLessThanOrEqual(MAX_POINTS_PER_STROKE);
    expect(strokes[0][0]).toEqual([0, 0]);
    expect(dropped).toBe(0);
  });

  it('leaves out strokes that would take the drawing past 1500 points', () => {
    const { strokes, dropped } = limitStrokes([zigzag(400), zigzag(400), zigzag(400), zigzag(400), zigzag(50)]);
    const total = strokes.reduce((n, s) => n + s.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_POINTS_TOTAL);
    expect(strokes).toHaveLength(4);
    expect(strokes[3]).toHaveLength(50);
    expect(dropped).toBe(1);
  });
});

describe('normalizeDrawing', () => {
  const rect = { x: 100, y: 200, w: 300, h: 150 };

  it('makes points relative to the element rect, rounded to 3 decimals, with a bbox', () => {
    const drawing = normalizeDrawing([[[100, 200], [250, 275], [400.4567, 350]]], rect);
    expect(drawing.strokes).toEqual([[[0, 0], [0.5, 0.5], [1.002, 1]]]);
    expect(drawing.bbox).toEqual({ x: 0, y: 0, w: 1.002, h: 1 });
  });

  it('allows marks outside the element but clamps them to ±10', () => {
    const drawing = normalizeDrawing([[[100 - 300 * 20, 200], [100 + 300 * 15, 200 + 150 * 2]]], rect);
    expect(drawing.strokes[0]).toEqual([[-10, 0], [10, 2]]);
  });

  it('gives finite coordinates for a zero-size element', () => {
    const drawing = normalizeDrawing([[[5, 5], [6, 6]]], { x: 5, y: 5, w: 0, h: 0 });
    expect(drawing.strokes[0].flat().every(Number.isFinite)).toBe(true);
  });

  it('scales back to the element at whatever size it has now', () => {
    const drawing = normalizeDrawing([[[100, 200], [400, 350]]], rect);
    expect(drawingToPixels(drawing, { x: 0, y: 0, w: 600, h: 300 })).toEqual([[[0, 0], [600, 300]]]);
  });
});

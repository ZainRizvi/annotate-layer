import { rectOf } from './drawing';
import { buildAnchor } from './picker';
import type { AnnotateHostContext, AnnotationAnchor, AnnotationContext, AnnotationRect } from './types';

/**
 * The screen as it was when the element was picked (or a drawing was
 * finished). Taken before the sheet opens, so the on-screen keyboard and the
 * sheet's own scrolling do not distort it.
 */
export interface PickSnapshot {
  viewport: { w: number; h: number; dpr: number };
  scroll: { x: number; y: number };
  /** Viewport rect of each element of the pick chain, in chain order. */
  rects: AnnotationRect[];
  /**
   * Anchor of each element of the pick chain, in chain order: the note
   * describes the page as it was picked, not as it is when Save is pressed
   * (streaming text, a reordered list).
   */
  anchors: AnnotationAnchor[];
}

export function snapshotPick(chain: Element[], path: string, url: string): PickSnapshot {
  return {
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    scroll: { x: window.scrollX, y: window.scrollY },
    rects: chain.map(rectOf),
    anchors: chain.map((el) => buildAnchor(el, path, url)),
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** `rect` in whole tenths of a pixel, the precision stored with the anchor. */
export function roundRect(rect: AnnotationRect): AnnotationRect {
  return { x: round1(rect.x), y: round1(rect.y), w: round1(rect.w), h: round1(rect.h) };
}

export function buildContext(
  snapshot: PickSnapshot,
  input: 'touch' | 'pointer',
  host: AnnotateHostContext
): AnnotationContext {
  return {
    viewport: snapshot.viewport,
    scroll: { x: Math.round(snapshot.scroll.x), y: Math.round(snapshot.scroll.y) },
    input,
    env: host.env,
    ...(host.buildSha ? { build_sha: host.buildSha } : {}),
    theme: host.theme,
    lang: host.lang,
    ua: navigator.userAgent,
  };
}

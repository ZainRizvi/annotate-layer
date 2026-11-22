/**
 * Hook that resolves each note's anchor to an element on the current page, again when the notes or the DOM change.
 */

'use client';

import { useEffect, useState } from 'react';
import type { AnnotationItem } from './types';
import { findAnchor, isInLayerUI } from './picker';

export type AnchorMap = ReadonlyMap<number, Element | null>;

const RESOLVE_DEBOUNCE_MS = 300;
/** Snippet searches that came up empty run again at most this often while the page changes. */
export const SNIPPET_RETRY_MS = 1000;

/**
 * `searched` holds notes whose snippet search came up empty: the search is
 * the expensive step, so those notes skip it until the next retry pass. The
 * cheap `data-ann` and CSS-path lookups run every time.
 */
function resolveAll(notes: AnnotationItem[], searched: Set<number>): Map<number, Element | null> {
  const map = new Map<number, Element | null>();
  for (const note of notes) {
    const el = findAnchor(note.anchor, document, { snippetSearch: !searched.has(note.number) });
    if (!el) searched.add(note.number);
    map.set(note.number, el);
  }
  return map;
}

function sameMap(a: AnchorMap, b: AnchorMap): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || b.get(key) !== value) return false;
  }
  return true;
}

/**
 * Where each note's element is on the current page (`null` = moved). Resolves
 * again when the notes change and, debounced, when the page's DOM changes.
 * Notes still missing get their snippet search again once the page has
 * changed, at most once per SNIPPET_RETRY_MS, so an element that renders
 * late (a lazily loaded item) is found.
 */
export function useAnchoredNotes(notes: AnnotationItem[]): AnchorMap {
  const [anchors, setAnchors] = useState<AnchorMap>(() => new Map());

  useEffect(() => {
    // New notes (a reload, a save, a status change) get a fresh search.
    const searched = new Set<number>();
    const update = () => {
      const next = resolveAll(notes, searched);
      setAnchors((prev) => (sameMap(prev, next) ? prev : next));
    };
    update();
    if (notes.length === 0) return;

    let timer = 0;
    let retryTimer = 0;
    let lastSearchPass = Date.now();
    const retrySearches = () => {
      retryTimer = 0;
      lastSearchPass = Date.now();
      searched.clear();
      window.clearTimeout(timer);
      update();
    };
    const observer = new MutationObserver((records) => {
      const onlyLayerUI = records.every((r) =>
        isInLayerUI(r.target instanceof Element ? r.target : r.target.parentElement)
      );
      if (onlyLayerUI) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(update, RESOLVE_DEBOUNCE_MS);
      if (searched.size > 0 && !retryTimer) {
        const wait = Math.max(RESOLVE_DEBOUNCE_MS, lastSearchPass + SNIPPET_RETRY_MS - Date.now());
        retryTimer = window.setTimeout(retrySearches, wait);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
      window.clearTimeout(retryTimer);
    };
  }, [notes]);

  return anchors;
}

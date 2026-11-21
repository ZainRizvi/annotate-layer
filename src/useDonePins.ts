'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotateStorage, AnnotationItem } from './types';
import {
  DONE_PINS_STORAGE_KEY,
  donePinKey,
  loadDonePins,
  updateDonePins,
  withHidden,
  withViews,
  wornOutKeys,
  type DonePinEntries,
} from './donePins';

export interface DonePins {
  /**
   * False for a done note whose pin was hidden, or was seen on
   * DONE_PIN_MAX_VIEWS page views before this one. Other notes always show.
   */
  showsPin: (note: AnnotationItem) => boolean;
  /** Pins on screen now: each done one counts once per page view. */
  recordShown: (notes: readonly AnnotationItem[]) => void;
  /** Hides these notes' done pins at once. */
  hide: (notes: readonly AnnotationItem[]) => void;
}

interface State {
  entries: DonePinEntries;
  /** The page view's `path`; a new one starts when it changes. */
  path: string;
  /** Pins worn out when this page view started; a pin that wears out during it stays. */
  worn: ReadonlySet<string>;
  /** Views are counted (and worn-out pins left out) only while the storage works. */
  counting: boolean;
}

/**
 * `stored` with this layer's hides kept: a hide whose write failed lives only
 * in memory, and nothing un-hides a pin, so merging never brings one back.
 */
function withLocalHides(stored: DonePinEntries, local: DonePinEntries): DonePinEntries {
  const hidden = Object.keys(local).filter((key) => local[key].hidden && !stored[key]?.hidden);
  return hidden.length ? withHidden(stored, hidden) : stored;
}

function keysOf(notes: readonly AnnotationItem[]): string[] {
  const keys: string[] = [];
  for (const note of notes) {
    const key = donePinKey(note);
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * Done-pin expiry and hiding for one layer. A page view starts when the
 * layer mounts and whenever `path` changes; each start reads the storage
 * again, and so does a `storage` event for DONE_PINS_STORAGE_KEY (another
 * tab's write), so hides from other tabs apply at once. Pins that were not
 * worn out when the page view started keep showing until it ends. When the
 * storage throws, views are not counted and done pins show as the server
 * lists them; hiding still works until the layer unmounts.
 */
export function useDonePins(storage: AnnotateStorage, path: string): DonePins {
  const [state, setState] = useState<State>(() => {
    const stored = loadDonePins(storage);
    return { entries: stored ?? {}, path, worn: wornOutKeys(stored ?? {}), counting: stored !== null };
  });
  let current = state;
  if (state.path !== path) {
    const stored = loadDonePins(storage);
    const entries = stored ? withLocalHides(stored, state.entries) : state.entries;
    current = { entries, path, worn: wornOutKeys(entries), counting: state.counting && stored !== null };
    setState(current);
  }

  /** Keys counted in the current page view. */
  const countedRef = useRef<{ path: string; keys: Set<string> }>({ path, keys: new Set() });
  const countingRef = useRef(current.counting);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      // `key` is null when another tab cleared the whole storage.
      if (e.key !== null && e.key !== DONE_PINS_STORAGE_KEY) return;
      const stored = loadDonePins(storage);
      if (stored !== null) setState((s) => ({ ...s, entries: withLocalHides(stored, s.entries) }));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [storage]);

  const stopCounting = useCallback(() => {
    countingRef.current = false;
    setState((s) => ({ ...s, counting: false }));
  }, []);

  const recordShown = useCallback(
    (notes: readonly AnnotationItem[]) => {
      if (!countingRef.current) return;
      if (countedRef.current.path !== path) countedRef.current = { path, keys: new Set() };
      const counted = countedRef.current.keys;
      const fresh = keysOf(notes).filter((key) => !counted.has(key));
      if (fresh.length === 0) return;
      for (const key of fresh) counted.add(key);
      const written = updateDonePins(storage, (e) => withViews(e, fresh), Date.now());
      if (written === null) {
        stopCounting();
        return;
      }
      setState((s) => ({ ...s, entries: withLocalHides(written, s.entries) }));
    },
    [path, storage, stopCounting]
  );

  const hide = useCallback(
    (notes: readonly AnnotationItem[]) => {
      const keys = keysOf(notes);
      if (keys.length === 0) return;
      const written = updateDonePins(storage, (e) => withHidden(e, keys), Date.now());
      if (written === null) {
        stopCounting();
        setState((s) => ({ ...s, entries: withHidden(s.entries, keys) }));
        return;
      }
      setState((s) => ({ ...s, entries: withLocalHides(written, s.entries) }));
    },
    [storage, stopCounting]
  );

  const { entries, worn, counting } = current;
  const showsPin = useCallback(
    (note: AnnotationItem) => {
      const key = donePinKey(note);
      if (!key) return true;
      if (entries[key]?.hidden) return false;
      return !(counting && worn.has(key));
    },
    [entries, worn, counting]
  );

  return { showsPin, recordShown, hide };
}

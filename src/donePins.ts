/**
 * Per-viewer state of done pins: how many page views each one has been seen
 * on, and whether it was hidden. Kept in the layer's `AnnotateStorage` under
 * DONE_PINS_STORAGE_KEY as JSON, keyed by note number plus `closed_at`, so a
 * note that is reopened and closed again starts fresh.
 */

import type { AnnotateStorage, AnnotationItem } from './types';

export const DONE_PINS_STORAGE_KEY = 'ann:done-pins';

/**
 * localStorage. Failures (private mode, blocked storage, a full quota) throw,
 * so the readers below can fall back.
 */
export const defaultStorage: AnnotateStorage = {
  get: (key) => window.localStorage.getItem(key),
  set: (key, value) => window.localStorage.setItem(key, value),
};

/** A done pin shows on this many page views, then stops showing on later ones. */
export const DONE_PIN_MAX_VIEWS = 7;
/**
 * Entries for notes closed longer ago than this are dropped on write. The
 * server lists done notes for 7 days, so older ones never come back.
 */
export const DONE_PIN_KEEP_MS = 8 * 24 * 60 * 60 * 1000;

export interface DonePinEntry {
  /** Page views the pin was seen on. */
  views: number;
  hidden?: boolean;
}

export type DonePinEntries = Readonly<Record<string, DonePinEntry>>;

/** `<number>@<closed_at>` for a done note, or null when it is not done or has no `closed_at`. */
export function donePinKey(note: AnnotationItem): string | null {
  if (note.status !== 'done' || !note.closed_at) return null;
  return `${note.number}@${note.closed_at}`;
}

function closedAtOf(key: string): number {
  return Date.parse(key.slice(key.indexOf('@') + 1));
}

function isEntry(value: unknown): value is DonePinEntry {
  if (typeof value !== 'object' || value === null) return false;
  const { views, hidden } = value as Record<string, unknown>;
  return (
    typeof views === 'number' &&
    Number.isFinite(views) &&
    views >= 0 &&
    (hidden === undefined || typeof hidden === 'boolean')
  );
}

/**
 * The stored entries, or null when the storage cannot be read (it threw).
 * A missing or malformed value reads as no entries; malformed entries are
 * left out.
 */
export function loadDonePins(storage: AnnotateStorage): DonePinEntries | null {
  let raw: string | null;
  try {
    raw = storage.get(DONE_PINS_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  // fromEntries defines each key as its own property, so a stored key named `__proto__` stays data.
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isEntry(value)));
}

/** Without entries for notes closed more than DONE_PIN_KEEP_MS before `now`. */
export function prunedDonePins(entries: DonePinEntries, now: number): DonePinEntries {
  const kept: Record<string, DonePinEntry> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const closedAt = closedAtOf(key);
    if (Number.isFinite(closedAt) && now - closedAt <= DONE_PIN_KEEP_MS) kept[key] = entry;
  }
  return kept;
}

/** One more page view for each key. */
export function withViews(entries: DonePinEntries, keys: readonly string[]): DonePinEntries {
  const next = { ...entries };
  for (const key of keys) next[key] = { ...next[key], views: (next[key]?.views ?? 0) + 1 };
  return next;
}

export function withHidden(entries: DonePinEntries, keys: readonly string[]): DonePinEntries {
  const next = { ...entries };
  for (const key of keys) next[key] = { views: next[key]?.views ?? 0, hidden: true };
  return next;
}

/**
 * Applies `change` to the stored entries (read fresh, so other tabs' writes
 * are kept), prunes them and writes them back. Returns what was written, or
 * null when the storage threw.
 */
export function updateDonePins(
  storage: AnnotateStorage,
  change: (entries: DonePinEntries) => DonePinEntries,
  now: number
): DonePinEntries | null {
  const stored = loadDonePins(storage);
  if (stored === null) return null;
  const next = prunedDonePins(change(stored), now);
  try {
    storage.set(DONE_PINS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return null;
  }
  return next;
}

/** Keys whose pins were seen on DONE_PIN_MAX_VIEWS page views or more. */
export function wornOutKeys(entries: DonePinEntries): ReadonlySet<string> {
  const worn = new Set<string>();
  for (const [key, entry] of Object.entries(entries)) {
    if (entry.views >= DONE_PIN_MAX_VIEWS) worn.add(key);
  }
  return worn;
}

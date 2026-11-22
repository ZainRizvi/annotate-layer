/**
 * Reads and writes unsaved note drafts in the browser tab.
 * @external Browser session storage (sessionStorage): keeps unsaved note drafts until the tab closes
 */

/** The slice of sessionStorage the draft store uses. Every method throws when the storage is unavailable. */
export interface DraftStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Every key currently stored. */
  keys(): string[];
}

export const sessionDrafts: DraftStorage = {
  get: (key) => sessionStorage.getItem(key),
  set: (key, value) => sessionStorage.setItem(key, value),
  remove: (key) => sessionStorage.removeItem(key),
  keys: () =>
    Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)).flatMap((key) =>
      key === null ? [] : [key]
    ),
};

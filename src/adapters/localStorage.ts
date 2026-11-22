/**
 * Reads and writes the viewer's done-pin state in the browser.
 * @external Browser local storage (localStorage): remembers which done pins were seen or hidden
 */

/** A string key-value store. Both methods throw when the storage is unavailable. */
export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/**
 * localStorage. Failures (private mode, blocked storage, a full quota) throw,
 * so the readers in `donePins` can fall back.
 */
export const browserLocalStorage: KeyValueStorage = {
  get: (key) => window.localStorage.getItem(key),
  set: (key, value) => window.localStorage.setItem(key, value),
};

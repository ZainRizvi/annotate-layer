/** Reads one field of an untyped value, for the type guards that check parsed JSON. */

/** `value[key]`, or undefined when `value` is not an object or lacks the key. */
export function fieldOf(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

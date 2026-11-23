/** Wraps a host's capture so `begin` never throws and each handle settles at most once. */
import type { CaptureHandle, CreatedAnnotation, NoteCapture } from './types';

const INERT: CaptureHandle = { commit: () => Promise.resolve(), discard: () => undefined };

function settleOnce(inner: CaptureHandle): CaptureHandle {
  const state = { settled: false };
  const claim = (): boolean => {
    const first = !state.settled;
    state.settled = true;
    return first;
  };
  return {
    commit: async (created: CreatedAnnotation) => {
      if (!claim()) return;
      try {
        await inner.commit(created);
      } catch {
        // A failed extra never fails the note, which is already saved.
      }
    },
    discard: () => {
      if (!claim()) return;
      try {
        inner.discard();
      } catch {
        // Nothing to release that the host could act on.
      }
    },
  };
}

export function beginCapture(capture: NoteCapture | undefined): CaptureHandle {
  if (!capture) return INERT;
  try {
    return settleOnce(capture.begin());
  } catch {
    return INERT;
  }
}

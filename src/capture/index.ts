/**
 * Screenshot capture: a no-op until the screenshots build replaces it.
 * The shapes match `NoteCapture` and `CaptureHandle` in `../types`; the layer's import
 * boundary allows no `../` imports, so they are written out structurally here.
 */
export interface ScreenshotCaptureOptions {
  config(): { maskInputs: boolean };
  upload(number: number, blob: Blob): Promise<void>;
}

interface Handle {
  commit(created: { number: number }): Promise<void>;
  discard(): void;
}

const NOOP_HANDLE: Handle = {
  commit: () => Promise.resolve(),
  discard: () => undefined,
};

export function createScreenshotCapture(opts: ScreenshotCaptureOptions): { begin(): Handle } {
  void opts;
  return { begin: () => NOOP_HANDLE };
}

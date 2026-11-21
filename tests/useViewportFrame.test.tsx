import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, fireEvent } from '@testing-library/react';
import { useViewportFrame } from '../src/useViewportFrame';

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
}

async function flushFrames(ms = 50) {
  await act(async () => {
    // MutationObserver callbacks are microtasks; let them schedule first.
    await Promise.resolve();
    vi.advanceTimersByTime(ms);
  });
}

describe('useViewportFrame', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    setHidden(false);
    document.body.innerHTML = '<div id="page"></div>';
  });
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it('does no work on an idle page: no ticks and no frame callbacks over time', async () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() => useViewportFrame(true, onFrame));
    await flushFrames();
    const tick = result.current;
    const calls = onFrame.mock.calls.length;
    await flushFrames(10_000);
    expect(result.current).toBe(tick);
    expect(onFrame).toHaveBeenCalledTimes(calls);
  });

  it('ticks once per frame after a scroll or a DOM change', async () => {
    const { result } = renderHook(() => useViewportFrame(true));
    await flushFrames();
    const start = result.current;
    fireEvent.scroll(document.getElementById('page')!);
    fireEvent.scroll(document.getElementById('page')!);
    await flushFrames();
    expect(result.current).toBe(start + 1);
    document.getElementById('page')!.textContent = 'streamed text';
    await flushFrames();
    expect(result.current).toBe(start + 2);
  });

  it('ticks when a CSS transition or animation ends, so pins settle on the final position', async () => {
    const { result } = renderHook(() => useViewportFrame(true));
    await flushFrames();
    const start = result.current;
    // The sidebar's slide: no scroll, no DOM change, only a transition.
    fireEvent(document.getElementById('page')!, new Event('transitionend', { bubbles: true }));
    await flushFrames();
    expect(result.current).toBe(start + 1);
    fireEvent(document.getElementById('page')!, new Event('animationend', { bubbles: true }));
    await flushFrames();
    expect(result.current).toBe(start + 2);
  });

  it('runs the frame callback but does not re-render the caller while inactive', async () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() => useViewportFrame(false, onFrame));
    await flushFrames();
    const start = result.current;
    onFrame.mockClear();
    fireEvent.scroll(document.getElementById('page')!);
    await flushFrames();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(start);
  });

  it('schedules nothing while the tab is hidden', async () => {
    const onFrame = vi.fn();
    const { result } = renderHook(() => useViewportFrame(true, onFrame));
    await flushFrames();
    const start = result.current;
    onFrame.mockClear();
    setHidden(true);
    fireEvent.scroll(document.getElementById('page')!);
    document.getElementById('page')!.textContent = 'changed while hidden';
    await flushFrames();
    expect(onFrame).not.toHaveBeenCalled();
    expect(result.current).toBe(start);

    setHidden(false);
    fireEvent(document, new Event('visibilitychange'));
    await flushFrames();
    expect(result.current).toBe(start + 1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import {
  useLongPress,
  LONG_PRESS_MS,
  PRESSING_CLASS,
  PRESSING_CLASS_MS,
} from '../src/useLongPress';

const touch = (x = 50, y = 50) => ({ pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: x, clientY: y });

function setup(enabled = true) {
  document.body.innerHTML = `
    <div data-ann="answer-body"><p id="p">Some answer text</p><a id="link" href="#x">link</a></div>
    <textarea id="ta"></textarea>
    <div data-ann-ui><button id="own">layer</button></div>
    <div id="scroller" style="overflow:auto"></div>`;
  const onLongPress = vi.fn();
  const onArm = vi.fn();
  const onDisarm = vi.fn();
  const stroke = { begin: vi.fn(), extend: vi.fn(), end: vi.fn(), cancel: vi.fn() };
  const hook = renderHook(
    ({ on }) => useLongPress({ enabled: on, onLongPress, onArm, onDisarm, stroke }),
    { initialProps: { on: enabled } }
  );
  return { onLongPress, onArm, onDisarm, stroke, hook, el: (id: string) => document.getElementById(id)! };
}

describe('useLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.remove(PRESSING_CLASS);
  });

  it('fires once the press has been held still for the threshold, and picks on release', () => {
    const { onLongPress, onArm, stroke, el } = setup();
    fireEvent.pointerDown(el('p'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onArm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onArm).toHaveBeenCalledWith(el('p'));
    expect(onLongPress).not.toHaveBeenCalled();
    // A little drift while holding is still a pick.
    fireEvent.pointerMove(el('p'), touch(56, 56));
    fireEvent.pointerUp(el('p'), touch(56, 56));
    expect(onLongPress).toHaveBeenCalledWith(el('p'), { x: 50, y: 50 });
    expect(stroke.begin).not.toHaveBeenCalled();
  });

  it('turns into a pen stroke when the finger moves after the press fired, and does not pick', () => {
    const { onLongPress, stroke, el } = setup();
    fireEvent.pointerDown(el('p'), touch(50, 50));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerMove(el('p'), touch(50, 58));
    expect(stroke.begin).not.toHaveBeenCalled();
    fireEvent.pointerMove(el('p'), touch(50, 62));
    expect(stroke.begin).toHaveBeenCalledWith([[50, 50], [50, 62]], 'touch');
    fireEvent.pointerMove(el('p'), touch(70, 80));
    expect(stroke.extend).toHaveBeenCalledWith([70, 80]);
    fireEvent.pointerUp(el('p'), touch(70, 80));
    expect(stroke.end).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains(PRESSING_CLASS)).toBe(false);
  });

  it('keeps following the stroke after the caller turns long-press off for draw mode', () => {
    const { stroke, hook, el } = setup();
    fireEvent.pointerDown(el('p'), touch(50, 50));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerMove(el('p'), touch(80, 50));
    hook.rerender({ on: false });
    fireEvent.pointerMove(el('p'), touch(90, 50));
    fireEvent.pointerUp(el('p'), touch(90, 50));
    expect(stroke.extend).toHaveBeenCalledWith([90, 50]);
    expect(stroke.end).toHaveBeenCalledTimes(1);
  });

  it('prevents touchmove (page scrolling) only once the press has fired', () => {
    const { el } = setup();
    const add = vi.spyOn(document, 'addEventListener');
    const touchmove = () => {
      const e = new Event('touchmove', { bubbles: true, cancelable: true });
      el('p').dispatchEvent(e);
      return e.defaultPrevented;
    };
    // No press: nothing listens, so scrolling is untouched.
    expect(touchmove()).toBe(false);
    fireEvent.pointerDown(el('p'), touch());
    expect(add.mock.calls.filter(([type]) => type === 'touchmove')).toHaveLength(1);
    expect(add.mock.calls.find(([type]) => type === 'touchmove')?.[2]).toMatchObject({ passive: false });
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(touchmove()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(touchmove()).toBe(true);
    fireEvent.pointerUp(el('p'), touch());
    expect(touchmove()).toBe(false);

    // A press released before it fires never blocks, and removes its listener.
    const remove = vi.spyOn(document, 'removeEventListener');
    fireEvent.pointerDown(el('p'), touch());
    vi.advanceTimersByTime(100);
    fireEvent.pointerUp(el('p'), touch());
    expect(remove.mock.calls.some(([type]) => type === 'touchmove')).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(touchmove()).toBe(false);
    add.mockRestore();
    remove.mockRestore();
  });

  describe('a second finger (pinch-zoom)', () => {
    const second = (x = 120, y = 120) => ({ pointerType: 'touch', isPrimary: false, pointerId: 2, clientX: x, clientY: y });
    const touchmove = (target: Element) => {
      const e = new Event('touchmove', { bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const touchstartWith = (target: Element, fingers: number) => {
      const e = new Event('touchstart', { bubbles: true });
      Object.defineProperty(e, 'touches', { value: { length: fingers } });
      target.dispatchEvent(e);
    };

    it('cancels a pending press, so a pinch never arms a note', () => {
      const { onArm, onLongPress, el } = setup();
      fireEvent.pointerDown(el('p'), touch());
      vi.advanceTimersByTime(300);
      fireEvent.pointerDown(el('p'), second());
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
      expect(onArm).not.toHaveBeenCalled();
      expect(touchmove(el('p'))).toBe(false);
      fireEvent.pointerUp(el('p'), touch());
      expect(onLongPress).not.toHaveBeenCalled();
      expect(document.documentElement.classList.contains(PRESSING_CLASS)).toBe(false);
    });

    it('also cancels on a two-finger touchstart without pointer events for the second finger', () => {
      const { onArm, el } = setup();
      fireEvent.pointerDown(el('p'), touch());
      vi.advanceTimersByTime(300);
      touchstartWith(el('p'), 2);
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(onArm).not.toHaveBeenCalled();
    });

    it('after the press fired: stops blocking the pinch, and neither picks nor draws', () => {
      const { onArm, onDisarm, onLongPress, stroke, el } = setup();
      fireEvent.pointerDown(el('p'), touch(50, 50));
      vi.advanceTimersByTime(LONG_PRESS_MS);
      expect(onArm).toHaveBeenCalled();
      expect(touchmove(el('p'))).toBe(true);

      fireEvent.pointerDown(el('p'), second());
      expect(touchmove(el('p'))).toBe(false);
      expect(onDisarm).toHaveBeenCalledTimes(1);
      // The pinch spreads both fingers well past the stroke threshold.
      fireEvent.pointerMove(el('p'), touch(20, 20));
      fireEvent.pointerUp(el('p'), touch(20, 20));
      expect(stroke.begin).not.toHaveBeenCalled();
      expect(onLongPress).not.toHaveBeenCalled();
      expect(document.documentElement.classList.contains(PRESSING_CLASS)).toBe(false);
    });

    it('drops a hold-then-drag stroke when a second finger joins', () => {
      const { onLongPress, stroke, el } = setup();
      fireEvent.pointerDown(el('p'), touch(50, 50));
      vi.advanceTimersByTime(LONG_PRESS_MS);
      fireEvent.pointerMove(el('p'), touch(50, 80));
      expect(stroke.begin).toHaveBeenCalledTimes(1);
      touchstartWith(el('p'), 2);
      fireEvent.pointerMove(el('p'), touch(50, 120));
      fireEvent.pointerUp(el('p'), touch(50, 120));
      expect(stroke.cancel).toHaveBeenCalledTimes(1);
      expect(stroke.extend).not.toHaveBeenCalled();
      expect(stroke.end).not.toHaveBeenCalled();
      expect(onLongPress).not.toHaveBeenCalled();
      expect(touchmove(el('p'))).toBe(false);
    });
  });

  it('a cancelled touch picks if the finger stayed still, and ends a stroke in progress', () => {
    const { onLongPress, onDisarm, stroke, el } = setup();
    fireEvent.pointerDown(el('p'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerCancel(el('p'), touch());
    expect(onLongPress).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(el('p'), touch(50, 50));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerMove(el('p'), touch(50, 90));
    fireEvent.pointerCancel(el('p'), touch(50, 90));
    expect(stroke.end).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onDisarm).not.toHaveBeenCalled();
  });

  it('adds the selection-suppressing class after 200 ms and removes it on release', () => {
    const { el } = setup();
    const html = document.documentElement;
    fireEvent.pointerDown(el('p'), touch());
    vi.advanceTimersByTime(PRESSING_CLASS_MS - 1);
    expect(html.classList.contains(PRESSING_CLASS)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(html.classList.contains(PRESSING_CLASS)).toBe(true);
    fireEvent.pointerUp(el('p'), touch());
    expect(html.classList.contains(PRESSING_CLASS)).toBe(false);
  });

  it('allows small finger drift but cancels on movement over 10 px before it fires', () => {
    const { onArm, el } = setup();
    fireEvent.pointerDown(el('p'), touch(50, 50));
    fireEvent.pointerMove(el('p'), touch(56, 56));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onArm).toHaveBeenCalledTimes(1);

    fireEvent.pointerUp(el('p'), touch());
    fireEvent.pointerDown(el('p'), touch(50, 50));
    fireEvent.pointerMove(el('p'), touch(50, 61));
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onArm).toHaveBeenCalledTimes(1);
  });

  it('cancels on early release and on pointercancel', () => {
    const { onLongPress, el } = setup();
    fireEvent.pointerDown(el('p'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    fireEvent.pointerUp(el('p'), touch());
    fireEvent.pointerDown(el('p'), touch());
    vi.advanceTimersByTime(100);
    fireEvent.pointerCancel(el('p'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels when anything scrolls, so scrolling never opens a note', () => {
    const { onLongPress, el } = setup();
    fireEvent.pointerDown(el('p'), touch());
    vi.advanceTimersByTime(300);
    fireEvent.scroll(el('scroller'));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains(PRESSING_CLASS)).toBe(false);
  });

  it('ignores inputs and the layer UI so native text editing keeps working', () => {
    const { onLongPress, el } = setup();
    fireEvent.pointerDown(el('ta'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    fireEvent.pointerUp(el('ta'), touch());
    fireEvent.pointerDown(el('own'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains(PRESSING_CLASS)).toBe(false);
  });

  it('ignores mouse presses', () => {
    const { onLongPress, el } = setup();
    fireEvent.pointerDown(el('p'), { ...touch(), pointerType: 'mouse' });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('swallows the click and contextmenu that follow a long-press, then lets taps through', () => {
    const { el } = setup();
    const onClick = vi.fn();
    el('link').addEventListener('click', onClick);

    fireEvent.pointerDown(el('link'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    const menuAllowed = fireEvent.contextMenu(el('link'));
    fireEvent.pointerUp(el('link'), touch());
    const clickAllowed = fireEvent.click(el('link'));
    expect(menuAllowed).toBe(false);
    expect(clickAllowed).toBe(false);
    expect(onClick).not.toHaveBeenCalled();

    // An ordinary tap afterwards behaves normally.
    fireEvent.pointerDown(el('link'), touch());
    fireEvent.pointerUp(el('link'), touch());
    fireEvent.click(el('link'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keeps swallowing the follow-up click after the caller disables long-press on fire', () => {
    const { el, hook } = setup();
    const onClick = vi.fn();
    el('link').addEventListener('click', onClick);
    fireEvent.pointerDown(el('link'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    // The layer turns long-press off as soon as its note sheet opens.
    hook.rerender({ on: false });
    expect(document.documentElement.classList.contains(PRESSING_CLASS)).toBe(true);
    fireEvent.pointerUp(el('link'), touch());
    expect(document.documentElement.classList.contains(PRESSING_CLASS)).toBe(false);
    fireEvent.click(el('link'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('lets the first click through when it lands somewhere other than the pressed element', () => {
    const { el } = setup();
    const onLinkClick = vi.fn();
    const onOwnClick = vi.fn();
    el('link').addEventListener('click', onLinkClick);
    el('own').addEventListener('click', onOwnClick);

    fireEvent.pointerDown(el('link'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerUp(el('link'), touch());
    // The admin's first tap lands on the sheet that just opened.
    expect(fireEvent.click(el('own'))).toBe(true);
    expect(onOwnClick).toHaveBeenCalledTimes(1);
    // That click ended the window: the pressed element is clickable again.
    fireEvent.click(el('link'));
    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });

  it('swallows a release click on a child of the pressed element', () => {
    document.body.innerHTML = '<a id="chip" href="#c"><span id="label">User Guide</span></a>';
    const onLongPress = vi.fn();
    renderHook(() => useLongPress({ enabled: true, onLongPress }));
    const onClick = vi.fn();
    const chip = document.getElementById('chip')!;
    chip.addEventListener('click', onClick);
    fireEvent.pointerDown(chip, touch());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerUp(chip, touch());
    fireEvent.click(document.getElementById('label')!);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('swallows the release click on an ancestor when the finger drifted onto a sibling', () => {
    document.body.innerHTML =
      '<a id="link" href="#c"><span id="first">User Guide</span><span id="second">Section 12</span></a><button id="other">x</button>';
    const onLongPress = vi.fn();
    renderHook(() => useLongPress({ enabled: true, onLongPress }));
    const link = document.getElementById('link')!;
    const onLinkClick = vi.fn();
    const onOtherClick = vi.fn();
    link.addEventListener('click', onLinkClick);
    document.getElementById('other')!.addEventListener('click', onOtherClick);

    fireEvent.pointerDown(document.getElementById('first')!, touch(50, 50));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerUp(document.getElementById('second')!, touch(56, 50));
    // Down and up on different children: the click goes to the link they share.
    expect(fireEvent.click(link)).toBe(false);
    expect(onLinkClick).not.toHaveBeenCalled();
    expect(onLongPress).toHaveBeenCalledTimes(1);

    // One release click only: the next click on the link goes through.
    fireEvent.click(link);
    expect(onLinkClick).toHaveBeenCalledTimes(1);

    // An unrelated element's click is never swallowed.
    fireEvent.pointerDown(document.getElementById('first')!, touch(50, 50));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerUp(document.getElementById('first')!, touch(50, 50));
    expect(fireEvent.click(document.getElementById('other')!)).toBe(true);
    expect(onOtherClick).toHaveBeenCalledTimes(1);
  });

  it('stops swallowing shortly after release when no click follows', () => {
    const { el } = setup();
    const onClick = vi.fn();
    el('link').addEventListener('click', onClick);
    fireEvent.pointerDown(el('link'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    fireEvent.pointerUp(el('link'), touch());
    vi.advanceTimersByTime(1000);
    fireEvent.click(el('link'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('attaches no listeners while disabled', () => {
    const { onArm, el, hook } = setup(false);
    fireEvent.pointerDown(el('p'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onArm).not.toHaveBeenCalled();
    hook.rerender({ on: true });
    fireEvent.pointerDown(el('p'), touch());
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onArm).toHaveBeenCalledTimes(1);
  });
});

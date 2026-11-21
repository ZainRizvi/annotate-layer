import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import type { AnnotationItem, AnnotationStatus } from '../src/types';
import Pins, { PIN_GAP, PIN_SIZE, STATUS_COLORS } from '../src/Pins';
import { NotesListSheet } from '../src/NotesSheets';
import { useAnchoredNotes } from '../src/useAnchoredNotes';
import { fakeClient } from './helpers';

function note(number: number, status: AnnotationStatus, annId: string, snippet?: string): AnnotationItem {
  return {
    number,
    html_url: `https://github.com/o/r/issues/${number}`,
    title: `[ann] note ${number}`,
    text: `Note ${number} text`,
    type: 'bug',
    status,
    anchor: { path: '/', url: 'http://localhost/', ann_id: annId, css_path: '', ...(snippet ? { text_snippet: snippet } : {}) },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    author: 'admin',
  };
}

function placeAt(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON() {} }) as DOMRect;
}

function Harness({
  notes,
  onOpen = () => {},
  onOpenGroup = () => {},
}: {
  notes: AnnotationItem[];
  onOpen?: (n: AnnotationItem) => void;
  onOpenGroup?: (group: AnnotationItem[]) => void;
}) {
  const anchors = useAnchoredNotes(notes);
  return (
    <>
      <div data-ann-ui="">
        <Pins notes={notes} anchors={anchors} frame={0} onOpen={onOpen} onOpenGroup={onOpenGroup} />
      </div>
      <NotesListSheet
        client={fakeClient()}
        notes={notes}
        anchors={anchors}
        loading={false}
        error={null}
        onShow={() => {}}
        onUpdated={() => {}}
        onGone={() => {}}
        onClose={() => {}}
      />
    </>
  );
}

describe('annotation pins', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div data-ann="composer" id="a"></div>
      <div data-ann="home-hero" id="b"></div>
      <div data-ann="sidebar" id="c"></div>
      <div data-ann="doc-quote" dir="rtl" style="direction: rtl" id="rtl"></div>`;
    placeAt(document.getElementById('a')!, { left: 10, top: 100, width: 200, height: 40 });
    placeAt(document.getElementById('b')!, { left: 10, top: 200, width: 200, height: 40 });
    placeAt(document.getElementById('c')!, { left: 10, top: 300, width: 200, height: 40 });
    placeAt(document.getElementById('rtl')!, { left: 30, top: 400, width: 200, height: 40 });
  });

  it('colors each pin by status', () => {
    render(<Harness notes={[note(1, 'open', 'composer'), note(2, 'working', 'home-hero'), note(3, 'done', 'sidebar')]} />);
    const colors = (['open', 'working', 'done'] as const).map((status, i) => {
      const pin = screen.getByRole('button', { name: `Note #${i + 1}, ${status[0].toUpperCase()}${status.slice(1)}` });
      expect(pin).toHaveAttribute('data-status', status);
      return pin.style.getPropertyValue('--ann-pin');
    });
    expect(colors).toEqual([STATUS_COLORS.open, STATUS_COLORS.working, STATUS_COLORS.done]);
    expect(new Set(colors).size).toBe(3);
  });

  it('places the pin at the top-end corner, which is the left edge for RTL content', () => {
    render(<Harness notes={[note(1, 'open', 'composer'), note(4, 'open', 'doc-quote')]} />);
    const ltr = screen.getByRole('button', { name: /Note #1,/ });
    const rtl = screen.getByRole('button', { name: /Note #4,/ });
    expect([ltr.style.left, ltr.style.top]).toEqual(['210px', '100px']);
    expect([rtl.style.left, rtl.style.top]).toEqual(['30px', '400px']);
  });

  it('shows a note as moved instead of pinning it when its element is gone', async () => {
    render(
      <Harness notes={[note(1, 'open', 'composer'), note(9, 'open', 'quality-badge', 'A badge that no longer exists')]} />
    );
    expect(screen.queryByRole('button', { name: /Note #9,/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Note #1,/ })).toBeInTheDocument();

    const rows = screen.getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent('moved');
    expect(rows[0]).not.toHaveTextContent('moved');

    await userEvent.click(screen.getByRole('button', { name: /Note 9 text/ }));
    expect(screen.queryByRole('button', { name: 'Show on page' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Note 1 text/ }));
    expect(screen.getByRole('button', { name: 'Show on page' })).toBeInTheDocument();
  });

  it('shows no pin for an element translated off screen, like the closed mobile sidebar', () => {
    placeAt(document.getElementById('c')!, { left: -280, top: 0, width: 280, height: 844 });
    render(<Harness notes={[note(3, 'open', 'sidebar'), note(1, 'open', 'composer')]} />);
    expect(screen.queryByRole('button', { name: /Note #3,/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Note #1,/ })).toBeInTheDocument();
  });

  it('hides a pin whose corner is covered by something else, like an open modal', () => {
    const modal = document.createElement('div');
    document.body.appendChild(modal);
    const original = document.elementsFromPoint;
    document.elementsFromPoint = (x: number, y: number) =>
      y < 150 ? [modal, document.body] : [document.getElementById('b')!, document.body];
    try {
      render(<Harness notes={[note(1, 'open', 'composer'), note(2, 'open', 'home-hero')]} />);
      expect(screen.queryByRole('button', { name: /Note #1,/ })).toBeNull();
      expect(screen.getByRole('button', { name: /Note #2,/ })).toBeInTheDocument();
    } finally {
      document.elementsFromPoint = original;
    }
  });

  it('looks through its own pin: a small chip under a modal loses its pin', () => {
    // A citation chip so small that the pin sits over the corner probe point.
    const chip = document.createElement('span');
    chip.setAttribute('data-ann', 'citation-chip');
    document.body.appendChild(chip);
    placeAt(chip, { left: 100, top: 300, width: 24, height: 16 });
    const modal = document.createElement('div');
    document.body.appendChild(modal);
    let modalOpen = false;
    const original = document.elementsFromPoint;
    const originalOne = document.elementFromPoint;
    // Layer UI first (the pin), then whatever the page has there.
    document.elementsFromPoint = () => [
      ...Array.from(document.querySelectorAll('.ann-pin')),
      modalOpen ? modal : chip,
      document.body,
    ];
    document.elementFromPoint = (x: number, y: number) => document.elementsFromPoint(x, y)[0];
    try {
      const notes = [note(7, 'open', 'citation-chip')];
      const { rerender } = render(<Harness notes={notes} />);
      expect(screen.getByRole('button', { name: /Note #7,/ })).toBeInTheDocument();
      // Re-measured with the pin now over the probe point: still visible.
      rerender(<Harness notes={[...notes]} />);
      expect(document.elementsFromPoint(0, 0)[0]).toHaveClass('ann-pin');
      expect(screen.getByRole('button', { name: /Note #7,/ })).toBeInTheDocument();
      // A details modal opens over the chip.
      modalOpen = true;
      rerender(<Harness notes={[...notes]} />);
      expect(screen.queryByRole('button', { name: /Note #7,/ })).toBeNull();
    } finally {
      document.elementsFromPoint = original;
      document.elementFromPoint = originalOne;
    }
  });

  describe('a note whose element is missing', () => {
    const searches = () =>
      querySpy.mock.calls.filter(([selector]: unknown[]) => selector === '[data-ann], [data-ann] *').length;
    let querySpy: ReturnType<typeof vi.spyOn>;
    const mutate = async (fn: () => void) => {
      await act(async () => {
        fn();
        await Promise.resolve();
      });
    };
    const wait = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    };
    beforeEach(() => {
      vi.useFakeTimers();
      querySpy = vi.spyOn(document, 'querySelectorAll');
    });
    afterEach(() => {
      querySpy.mockRestore();
      vi.useRealTimers();
    });

    it('is found once its element renders later, by a rate-limited retry of the snippet search', async () => {
      const missing = note(9, 'open', 'quality-badge', 'A badge that will appear later');
      render(<Harness notes={[missing]} />);
      expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('moved');
      const afterFirst = searches();
      expect(afterFirst).toBeGreaterThan(0);

      // Page activity: the debounced re-resolve runs, the snippet search does not yet.
      await mutate(() => document.body.appendChild(document.createElement('p')));
      await wait(400);
      expect(searches()).toBe(afterFirst);

      // The untagged element renders; the retry pass finds it.
      const later = document.createElement('div');
      later.textContent = 'A badge that will appear later';
      placeAt(later, { left: 10, top: 500, width: 200, height: 40 });
      await mutate(() => document.body.appendChild(later));
      await wait(700);
      expect(screen.getByRole('button', { name: /Note #9,/ })).toBeInTheDocument();
    });

    it('retries at most once a second however busy the page is, and not at all while it is idle', async () => {
      render(<Harness notes={[note(9, 'open', 'quality-badge', 'A badge that never appears here')]} />);
      const afterFirst = searches();
      // A streaming answer: a DOM change every 100 ms for 3 s.
      for (let i = 0; i < 30; i++) {
        await mutate(() => document.body.appendChild(document.createElement('span')));
        await wait(100);
      }
      const passes = (searches() - afterFirst) / afterFirst;
      expect(passes).toBeGreaterThanOrEqual(2);
      expect(passes).toBeLessThanOrEqual(3);
      const settled = searches();
      await wait(5000);
      expect(searches()).toBe(settled);
    });
  });

  describe('several notes on one element', () => {
    const left = (name: RegExp) => parseFloat(screen.getByRole('button', { name }).style.left);

    it('fans two pins out toward the inline start, 48 px apart, so both can be tapped', async () => {
      const onOpen = vi.fn();
      const a = note(1, 'open', 'composer');
      const b = note(2, 'working', 'composer');
      render(<Harness notes={[a, b]} onOpen={onOpen} />);
      // Working first: it is still being acted on.
      expect(left(/Note #2,/)).toBe(210);
      expect(left(/Note #1,/)).toBe(210 - PIN_SIZE - PIN_GAP);
      expect(screen.getByRole('button', { name: /Note #1,/ }).style.getPropertyValue('--ann-pin')).toBe(STATUS_COLORS.open);
      expect(screen.getByRole('button', { name: /Note #2,/ }).style.getPropertyValue('--ann-pin')).toBe(STATUS_COLORS.working);
      await userEvent.click(screen.getByRole('button', { name: /Note #1,/ }));
      await userEvent.click(screen.getByRole('button', { name: /Note #2,/ }));
      expect(onOpen.mock.calls.map(([n]) => n.number)).toEqual([1, 2]);
    });

    it('fans toward the right for right-to-left content', () => {
      render(<Harness notes={[note(4, 'open', 'doc-quote'), note(5, 'open', 'doc-quote')]} />);
      expect(left(/Note #4,/)).toBe(30);
      expect(left(/Note #5,/)).toBe(30 + PIN_SIZE + PIN_GAP);
    });

    it('shifts the whole row back on screen instead of stacking pins at the edge', () => {
      placeAt(document.getElementById('a')!, { left: 0, top: 100, width: 30, height: 40 });
      render(<Harness notes={[note(1, 'open', 'composer'), note(2, 'open', 'composer')]} />);
      const xs = [left(/Note #1,/), left(/Note #2,/)].sort((p, q) => p - q);
      expect(xs[0]).toBeGreaterThanOrEqual(10);
      expect(xs[1] - xs[0]).toBe(PIN_SIZE + PIN_GAP);
    });

    it('with four notes shows two pins and a "+2" pin that opens all four', async () => {
      const onOpen = vi.fn();
      const onOpenGroup = vi.fn();
      const group = [1, 2, 3, 4].map((n) => note(n, 'open', 'composer'));
      render(<Harness notes={group} onOpen={onOpen} onOpenGroup={onOpenGroup} />);
      const more = screen.getByRole('button', { name: '2 more notes here' });
      expect(screen.getAllByRole('button', { name: /^Note #\d+,/ })).toHaveLength(2);
      const xs = [left(/Note #1,/), left(/Note #2,/), parseFloat(more.style.left)];
      expect(xs).toEqual([210, 210 - 48, 210 - 96]);
      await userEvent.click(more);
      expect(onOpenGroup.mock.calls[0][0].map((n: AnnotationItem) => n.number)).toEqual([1, 2, 3, 4]);
    });
  });

  it('opens the note when its pin is tapped', async () => {
    const onOpen = vi.fn();
    const n = note(1, 'open', 'composer');
    render(<Harness notes={[n]} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: /Note #1,/ }));
    expect(onOpen).toHaveBeenCalledWith(n);
  });
});

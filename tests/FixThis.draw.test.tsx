import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { LONG_PRESS_MS } from '../src/useLongPress';
import { buildAnchor, textSnippet } from '../src/picker';
import { fakeClient, makeLayer } from './helpers';

const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const MOD = MAC ? { metaKey: true } : { ctrlKey: true };

const client = fakeClient();
const nav = { path: '/' };
const Layer = makeLayer(client, nav);

type Box = { left: number; top: number; width: number; height: number };
function placeAt(el: Element, box: Box) {
  el.getBoundingClientRect = () =>
    ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON() {} }) as DOMRect;
}

/** The answer sits at (100, 200) 200×100; its message wraps it at (0, 150) 400×300. */
function page() {
  document.body.innerHTML = `
    <div data-ann="message" id="message">
      <div data-ann="answer-body" id="answer"><p id="p">Answer text</p><a id="link" href="#go">Open</a></div>
    </div>`;
  placeAt(document.getElementById('message')!, { left: 0, top: 150, width: 400, height: 300 });
  placeAt(document.getElementById('answer')!, { left: 100, top: 200, width: 200, height: 100 });
  placeAt(document.getElementById('p')!, { left: 100, top: 200, width: 200, height: 20 });
}

const surface = () => document.querySelector('.ann-draw-surface')!;
const paths = () => Array.from(document.querySelectorAll('.ann-mark-stroke')).map((p) => p.getAttribute('d'));

/** A stroke drawn on the draw-mode surface. */
function drawOnSurface(points: Array<[number, number]>, pointerType = 'touch') {
  const base = { pointerId: 7, isPrimary: true, pointerType, button: 0 };
  const [first, ...rest] = points;
  fireEvent.pointerDown(surface(), { ...base, clientX: first[0], clientY: first[1] });
  for (const [x, y] of rest) fireEvent.pointerMove(surface(), { ...base, clientX: x, clientY: y });
  const last = points[points.length - 1];
  fireEvent.pointerUp(surface(), { ...base, clientX: last[0], clientY: last[1] });
}

async function openDrawMode() {
  await userEvent.click(await screen.findByRole('button', { name: /Annotations,/ }));
  await userEvent.click(screen.getByRole('menuitem', { name: /Draw/ }));
  return screen.getByRole('toolbar', { name: 'Drawing' });
}

describe('FixThis drawing', () => {
  const originalElementsFromPoint = document.elementsFromPoint;
  let hitAt: Array<[number, number]>;

  beforeEach(() => {
    page();
    sessionStorage.clear();
    nav.path = '/';
    Element.prototype.scrollIntoView = vi.fn();
    client.list.mockReset();
    client.list.mockResolvedValue([]);
    client.create.mockReset();
    client.create.mockResolvedValue({ number: 50, html_url: 'u', status: 'open', created_at: '' });
    hitAt = [];
    // jsdom has no layout: the drawing overlay, then the paragraph, then the page.
    document.elementsFromPoint = (x: number, y: number) => {
      hitAt.push([x, y]);
      return [surface(), document.getElementById('p')!, document.body, document.documentElement].filter(Boolean);
    };
  });
  afterEach(() => {
    document.elementsFromPoint = originalElementsFromPoint;
  });

  it('Draw from the menu: Undo, Clear and Cancel', async () => {
    render(<Layer />);
    const bar = await openDrawMode();
    expect(screen.queryByRole('button', { name: /Annotations,/ })).toBeNull();
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();

    drawOnSurface([[10, 10], [60, 10], [60, 60]]);
    drawOnSurface([[200, 200], [250, 260]]);
    expect(paths()).toHaveLength(2);
    expect(done).toBeEnabled();

    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(paths()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(paths()).toHaveLength(0);
    expect(done).toBeDisabled();

    drawOnSurface([[10, 10], [60, 10]]);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bar).not.toBeInTheDocument();
    expect(paths()).toHaveLength(0);
    expect(screen.getByRole('button', { name: /Annotations,/ })).toBeInTheDocument();
  });

  it('Escape leaves draw mode without reaching the app', async () => {
    const appEscape = vi.fn();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && appEscape();
    window.addEventListener('keydown', onKey);
    try {
      render(<Layer />);
      await openDrawMode();
      drawOnSurface([[10, 10], [60, 10]]);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('toolbar', { name: 'Drawing' })).toBeNull();
      expect(appEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });

  it('Done anchors the note to the element under the centre of the strokes and keeps the marks', async () => {
    render(<Layer />);
    await openDrawMode();
    // A circle around the answer: bbox 120..280 × 210..290, centre (200, 250).
    drawOnSurface([[120, 250], [200, 210], [280, 250], [200, 290], [120, 250]]);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(hitAt).toEqual([[200, 250]]);
    const sheet = screen.getByRole('dialog', { name: 'New note' });
    expect(screen.queryByRole('toolbar', { name: 'Drawing' })).toBeNull();
    // `p` resolves to its data-ann ancestor; the chain offers the message too.
    expect(screen.getByRole('button', { name: 'answer-body' })).toHaveAttribute('aria-pressed', 'true');
    expect(paths()).toEqual(['M120.0 250.0L200.0 210.0L280.0 250.0L200.0 290.0L120.0 250.0']);

    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Circled');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.create).toHaveBeenCalled());
    const { anchor } = client.create.mock.calls[0][0];
    expect(anchor.ann_id).toBe('answer-body');
    expect(anchor.rect).toEqual({ x: 100, y: 200, w: 200, h: 100 });
    expect(anchor.drawing).toEqual({
      strokes: [[[0.1, 0.5], [0.5, 0.1], [0.9, 0.5], [0.5, 0.9], [0.1, 0.5]]],
      bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    });
    expect(sheet).not.toBeInTheDocument();
    expect(paths()).toHaveLength(0);
  });

  it('asks before Escape throws away a drawn note, even without text', async () => {
    render(<Layer />);
    await openDrawMode();
    drawOnSurface([[100, 200], [300, 300]]);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('alert')).toHaveTextContent('Discard note?');
    expect(paths()).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
    expect(paths()).toHaveLength(0);
  });

  it('Cancel on a drawn note asks before throwing the marks away', async () => {
    render(<Layer />);
    await openDrawMode();
    drawOnSurface([[100, 200], [300, 300]]);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Discard note?');
    expect(paths()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
  });

  it('the close button on a drawn note asks before throwing the marks away', async () => {
    render(<Layer />);
    await openDrawMode();
    drawOnSurface([[100, 200], [300, 300]]);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Discard note?');
    expect(screen.getByRole('dialog', { name: 'New note' })).toBeInTheDocument();
    expect(paths()).toHaveLength(1);
  });

  it('a draft keeps its marks: navigating away and back brings back the text and the drawing', async () => {
    const { rerender } = render(<Layer />);
    await openDrawMode();
    drawOnSurface([[100, 200], [300, 300]]);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Circled');

    nav.path = '/faq';
    rerender(<Layer />);
    expect(paths()).toHaveLength(0);
    nav.path = '/';
    rerender(<Layer />);
    // The answer has moved down 100 px since; the marks follow it.
    placeAt(document.getElementById('answer')!, { left: 100, top: 300, width: 200, height: 100 });
    fireEvent.click(document.getElementById('p')!, MOD);
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Circled');
    expect(paths()).toEqual(['M100.0 300.0L300.0 400.0']);

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.create).toHaveBeenCalled());
    expect(client.create.mock.calls[0][0].anchor.drawing.strokes).toEqual([[[0, 0], [1, 1]]]);
  });

  it('a drawing-only draft comes back too, and Discard clears it with the draft', async () => {
    const { rerender } = render(<Layer />);
    await openDrawMode();
    drawOnSurface([[100, 200], [300, 300]]);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    nav.path = '/faq';
    rerender(<Layer />);
    nav.path = '/';
    rerender(<Layer />);
    fireEvent.click(document.getElementById('p')!, MOD);
    expect(paths()).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    fireEvent.click(document.getElementById('p')!, MOD);
    expect(paths()).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });

  it('a stored drawing that fails validation is dropped and the text still comes back', async () => {
    const answer = document.getElementById('answer')!;
    sessionStorage.setItem(
      'ann:draft:/|answer-body|0',
      JSON.stringify({
        text: 'Kept',
        type: 'bug',
        snippet: textSnippet(answer),
        anchor: buildAnchor(answer, '/', window.location.href),
        drawing: { strokes: [[['x', null]]] },
      })
    );
    render(<Layer />);
    await screen.findByRole('button', { name: /Annotations,/ });
    fireEvent.click(document.getElementById('p')!, MOD);
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Kept');
    expect(paths()).toHaveLength(0);
  });

  it('widening the selection re-normalizes the strokes to the new element', async () => {
    render(<Layer />);
    await openDrawMode();
    drawOnSurface([[100, 200], [300, 300]]);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'message' }));
    // The marks stay where they were drawn.
    expect(paths()).toEqual(['M100.0 200.0L300.0 300.0']);
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Whole message');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.create).toHaveBeenCalled());
    const { anchor } = client.create.mock.calls[0][0];
    expect(anchor.ann_id).toBe('message');
    expect(anchor.rect).toEqual({ x: 0, y: 150, w: 400, h: 300 });
    expect(anchor.drawing.strokes).toEqual([[[0.25, 0.167], [0.75, 0.5]]]);
  });

  it('redraws the marks over the element when it moves or resizes', async () => {
    render(<Layer />);
    await openDrawMode();
    drawOnSurface([[100, 200], [300, 300]]);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(paths()).toEqual(['M100.0 200.0L300.0 300.0']);

    // The answer reflows to half the width further down (rotation, a resize).
    placeAt(document.getElementById('answer')!, { left: 50, top: 400, width: 100, height: 50 });
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(paths()).toEqual(['M50.0 400.0L150.0 450.0']);
  });

  it('keeps the picked anchor in the draft while the element changes under the sheet', async () => {
    render(<Layer />);
    await screen.findByRole('button', { name: /Annotations,/ });
    fireEvent.click(document.getElementById('p')!, MOD);
    document.getElementById('p')!.textContent = 'Answer text, still streaming';
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Draft');
    const stored = Object.entries(sessionStorage).find(([k]) => k.startsWith('ann:draft:'))![1];
    expect(JSON.parse(stored).anchor.text_snippet).toBe('Answer textOpen');
  });

  it('records viewport, scroll and the element rect when the element is picked, not at save', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 640, configurable: true });
    render(<Layer />);
    await screen.findByRole('button', { name: /Annotations,/ });
    fireEvent.click(document.getElementById('p')!, MOD);

    // The keyboard opens and the sheet scrolls the page before Save.
    Object.defineProperty(window, 'innerHeight', { value: 500, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 900, configurable: true });
    placeAt(document.getElementById('answer')!, { left: 100, top: 60, width: 200, height: 100 });
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Spacing');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.create).toHaveBeenCalled());
    const { anchor, context } = client.create.mock.calls[0][0];
    expect(context.viewport).toMatchObject({ w: 390, h: 844 });
    expect(context.scroll).toEqual({ x: 0, y: 640 });
    expect(anchor.rect).toEqual({ x: 100, y: 200, w: 200, h: 100 });
    expect(anchor).not.toHaveProperty('drawing');
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  describe('⌘-drag', () => {
    it('draws a stroke instead of picking, and the release click neither picks nor opens the link', async () => {
      const onLinkClick = vi.fn();
      document.getElementById('link')!.addEventListener('click', onLinkClick);
      render(<Layer />);
      await screen.findByRole('button', { name: /Annotations,/ });
      const link = document.getElementById('link')!;

      // ⌘-press never starts a text selection.
      expect(fireEvent.mouseDown(link, { ...MOD, button: 0, clientX: 100, clientY: 100 })).toBe(false);
      fireEvent.mouseMove(link, { ...MOD, clientX: 103, clientY: 103 });
      expect(screen.queryByRole('toolbar', { name: 'Drawing' })).toBeNull();
      fireEvent.mouseMove(link, { ...MOD, clientX: 106, clientY: 104 });
      expect(screen.getByRole('toolbar', { name: 'Drawing' })).toBeInTheDocument();
      fireEvent.mouseMove(document.body, { ...MOD, clientX: 160, clientY: 140 });
      fireEvent.mouseUp(document.body, { ...MOD, clientX: 160, clientY: 140 });
      fireEvent.click(link, MOD);

      expect(onLinkClick).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
      expect(paths()).toEqual(['M100.0 100.0L160.0 140.0']);
    });

    it('a ⌘-click without moving still picks', async () => {
      render(<Layer />);
      await screen.findByRole('button', { name: /Annotations,/ });
      const p = document.getElementById('p')!;
      fireEvent.mouseDown(p, { ...MOD, button: 0, clientX: 100, clientY: 100 });
      fireEvent.mouseMove(p, { ...MOD, clientX: 103, clientY: 102 });
      fireEvent.mouseUp(p, { ...MOD, clientX: 103, clientY: 102 });
      fireEvent.click(p, MOD);
      expect(screen.getByRole('dialog', { name: 'New note' })).toBeInTheDocument();
      expect(screen.queryByRole('toolbar', { name: 'Drawing' })).toBeNull();
    });
  });

  describe('hold, then draw', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());
    const touch = (x: number, y: number) => ({ pointerType: 'touch', isPrimary: true, pointerId: 3, clientX: x, clientY: y });

    it('moving after the long-press fires draws, and does not pick', async () => {
      render(<Layer />);
      const p = document.getElementById('p')!;
      fireEvent.pointerDown(p, touch(120, 210));
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      // Fired: the element is outlined while the finger is still down.
      expect(document.querySelector('.ann-highlight')).toHaveAttribute('data-variant', 'pick');
      fireEvent.pointerMove(p, touch(150, 210));
      fireEvent.pointerMove(p, touch(200, 240));
      expect(screen.getByRole('toolbar', { name: 'Drawing' })).toBeInTheDocument();
      fireEvent.pointerUp(p, touch(200, 240));
      act(() => {
        vi.advanceTimersByTime(600);
      });

      expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
      expect(paths()).toEqual(['M120.0 210.0L150.0 210.0L200.0 240.0']);
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.getByRole('dialog', { name: 'New note' })).toBeInTheDocument();
    });

    it('a pinch during hold-then-drag leaves no draw mode and no note', () => {
      render(<Layer />);
      const p = document.getElementById('p')!;
      fireEvent.pointerDown(p, touch(120, 210));
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      fireEvent.pointerMove(p, touch(160, 240));
      expect(screen.getByRole('toolbar', { name: 'Drawing' })).toBeInTheDocument();
      fireEvent.pointerDown(p, { pointerType: 'touch', isPrimary: false, pointerId: 4, clientX: 200, clientY: 300 });
      fireEvent.pointerUp(p, touch(160, 240));
      expect(screen.queryByRole('toolbar', { name: 'Drawing' })).toBeNull();
      expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
      expect(document.querySelector('.ann-highlight')).toBeNull();
    });

    it('releasing without moving picks, as before', () => {
      render(<Layer />);
      const p = document.getElementById('p')!;
      fireEvent.pointerDown(p, touch(120, 210));
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS);
      });
      expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
      fireEvent.pointerUp(p, touch(120, 210));
      expect(screen.getByRole('dialog', { name: 'New note' })).toBeInTheDocument();
      expect(screen.queryByRole('toolbar', { name: 'Drawing' })).toBeNull();
    });
  });

  describe('a note with marks', () => {
    const note = {
      number: 8, html_url: 'u', title: '', text: 'Circled thing', type: 'design', status: 'open',
      anchor: {
        path: '/', url: '', ann_id: 'answer-body', css_path: '',
        drawing: { strokes: [[[0, 0], [1, 1]]], bbox: { x: 0, y: 0, w: 1, h: 1 } },
      },
      created_at: '', updated_at: '', author: 'a',
    };
    beforeEach(() => client.list.mockResolvedValue([note]));

    it('shows its strokes over its element while the note is open, scaled to the element now', async () => {
      render(<Layer />);
      await userEvent.click(await screen.findByRole('button', { name: 'Note #8, Open' }));
      expect(paths()).toEqual(['M100.0 200.0L300.0 300.0']);
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(paths()).toHaveLength(0);
    });

    it('"Show on page" opens the note with its marks', async () => {
      render(<Layer />);
      await userEvent.click(await screen.findByRole('button', { name: /Annotations,/ }));
      await userEvent.click(screen.getByRole('menuitem', { name: /Notes on this page/ }));
      await userEvent.click(await screen.findByRole('button', { name: /Circled thing/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Show on page' }));
      expect(screen.getByRole('dialog', { name: 'Note #8' })).toBeInTheDocument();
      expect(paths()).toEqual(['M100.0 200.0L300.0 300.0']);
      await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    });
  });
});

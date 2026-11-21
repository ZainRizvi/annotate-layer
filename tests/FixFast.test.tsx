import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { AnnotateError } from '../src/client';
import { LONG_PRESS_MS } from '../src/useLongPress';
import { fakeClient, hostContext, makeLayer } from './helpers';
import { FixFast } from '../src/FixFast';

const client = fakeClient();
const listAnnotations = client.list;
const setAnnotationStatus = client.setStatus;
const AnnotationUI = makeLayer(client, { path: '/' });

function page() {
  const root = document.createElement('div');
  root.id = 'page';
  root.innerHTML = `
    <div data-ann="answer-body"><p id="p">Answer text</p><a id="link" href="#go">Open</a></div>`;
  document.body.appendChild(root);
  return root;
}

async function openMenu() {
  await userEvent.click(await screen.findByRole('button', { name: /Annotations,/ }));
}

describe('FixFast', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    // jsdom has no scrolling; the layer scrolls the picked element into view.
    Element.prototype.scrollIntoView = vi.fn();
    listAnnotations.mockReset();
    listAnnotations.mockResolvedValue([]);
  });

  it('loads notes for the current page', async () => {
    render(<AnnotationUI />);
    await waitFor(() => expect(listAnnotations).toHaveBeenCalledWith('/', { fresh: false }));
  });

  it('counts open and working notes on the pin button', async () => {
    const base = { html_url: '', title: '', text: 't', type: 'bug', created_at: '', updated_at: '', author: 'a' };
    const anchor = { path: '/', url: '', css_path: '' };
    listAnnotations.mockResolvedValue([
      { ...base, number: 1, status: 'open', anchor },
      { ...base, number: 2, status: 'working', anchor },
      { ...base, number: 3, status: 'done', anchor },
    ]);
    render(<AnnotationUI />);
    expect(await screen.findByRole('button', { name: 'Annotations, 2 open on this page' })).toBeInTheDocument();
  });

  it('outlines the element of a note opened from its pin', async () => {
    page();
    const answer = document.querySelector('[data-ann="answer-body"]')!;
    answer.getBoundingClientRect = () =>
      ({ left: 20, top: 100, right: 220, bottom: 140, width: 200, height: 40, x: 20, y: 100, toJSON() {} }) as DOMRect;
    listAnnotations.mockResolvedValue([
      {
        number: 5, html_url: 'u', title: '', text: 'Answer too long', type: 'content', status: 'open',
        anchor: { path: '/', url: '', ann_id: 'answer-body', css_path: '' },
        created_at: '', updated_at: '', author: 'a',
      },
    ]);
    render(<AnnotationUI />);
    await userEvent.click(await screen.findByRole('button', { name: 'Note #5, Open' }));
    expect(screen.getByRole('dialog', { name: 'Note #5' })).toHaveTextContent('Answer too long');
    const outline = document.querySelector<HTMLElement>('.ann-highlight')!;
    expect([outline.style.left, outline.style.top, outline.style.width]).toEqual(['17px', '97px', '206px']);
  });

  it('a "+N" pin opens the list of that element\'s notes, all of which open', async () => {
    page();
    const answer = document.querySelector('[data-ann="answer-body"]')!;
    answer.getBoundingClientRect = () =>
      ({ left: 20, top: 100, right: 220, bottom: 140, width: 200, height: 40, x: 20, y: 100, toJSON() {} }) as DOMRect;
    const onAnswer = (number: number) => ({
      number, html_url: 'u', title: '', text: `On the answer ${number}`, type: 'bug', status: 'open',
      anchor: { path: '/', url: '', ann_id: 'answer-body', css_path: '' }, created_at: '', updated_at: '', author: 'a',
    });
    const elsewhere = { ...onAnswer(9), text: 'Somewhere else', anchor: { path: '/', url: '', css_path: 'body > aside' } };
    listAnnotations.mockResolvedValue([onAnswer(1), onAnswer(2), onAnswer(3), onAnswer(4), elsewhere]);
    render(<AnnotationUI />);
    await userEvent.click(await screen.findByRole('button', { name: '2 more notes here' }));
    const list = screen.getByRole('dialog', { name: 'Notes on this element' });
    for (const n of [1, 2, 3, 4]) expect(list).toHaveTextContent(`On the answer ${n}`);
    expect(list).not.toHaveTextContent('Somewhere else');
    await userEvent.click(screen.getByRole('button', { name: /On the answer 4/ }));
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'All notes on this page' }));
    expect(screen.getByRole('dialog', { name: 'Notes on this page' })).toHaveTextContent('Somewhere else');
  });

  describe('notes list', () => {
    const item = (number: number, extra: Record<string, unknown> = {}) => ({
      number, html_url: `https://github.com/o/r/issues/${number}`, title: '', text: `Note ${number}`,
      type: 'bug', status: 'open', anchor: { path: '/', url: '', css_path: '' },
      created_at: '', updated_at: '', author: 'a', ...extra,
    });

    async function openList() {
      render(<AnnotationUI />);
      await openMenu();
      await userEvent.click(screen.getByRole('menuitem', { name: /Notes on this page/ }));
      return screen.getByRole('dialog', { name: 'Notes on this page' });
    }

    it('takes focus into the list and gives it back to the pin button on close', async () => {
      listAnnotations.mockResolvedValue([item(1)]);
      await openList();
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.getByRole('button', { name: /Annotations,/ })).toHaveFocus();
    });

    it('shows a note without a type as untyped', async () => {
      listAnnotations.mockResolvedValue([item(1, { type: null })]);
      await openList();
      await userEvent.click(await screen.findByRole('button', { name: /Note 1/ }));
      expect(screen.getByText('untyped')).toBeInTheDocument();
    });

    it('drops a note whose issue is gone and says so', async () => {
      listAnnotations.mockResolvedValue([item(1), item(2)]);
      setAnnotationStatus.mockRejectedValue(new AnnotateError('not_found', 'annotation_not_found', 404));
      const list = await openList();
      await userEvent.click(await screen.findByRole('button', { name: /Note 1/ }));
      // The fresh reload after the 404 no longer lists the deleted issue.
      listAnnotations.mockResolvedValue([item(2)]);
      await userEvent.click(screen.getByRole('button', { name: 'Mark done' }));
      expect(await screen.findByText('This note no longer exists')).toBeInTheDocument();
      await waitFor(() =>
        expect(listAnnotations).toHaveBeenLastCalledWith('/', { fresh: true })
      );
      expect(list).not.toHaveTextContent('Note 1');
      expect(list).toHaveTextContent('Note 2');
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.getByRole('button', { name: 'Annotations, 1 open on this page' })).toBeInTheDocument();
    });

    it('keeps the note and shows the error for other failures', async () => {
      listAnnotations.mockResolvedValue([item(1)]);
      setAnnotationStatus.mockRejectedValue(new AnnotateError('http', 'Server Error', 502));
      const list = await openList();
      await userEvent.click(await screen.findByRole('button', { name: /Note 1/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Mark done' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('The notes store returned an error: Server Error');
      expect(list).toHaveTextContent('Note 1');
    });
  });

  it('tap-to-pick: the next tap picks the element instead of following the link', async () => {
    page();
    const onLinkClick = vi.fn();
    document.getElementById('link')!.addEventListener('click', onLinkClick);
    render(<AnnotationUI />);
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /Annotate/ }));
    expect(screen.getByRole('status')).toHaveTextContent('Tap anything');

    await userEvent.click(document.getElementById('link')!);
    expect(onLinkClick).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'New note' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'answer-body' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Tap anything')).toBeNull();
  });

  it('cancels tap-to-pick from the banner', async () => {
    page();
    render(<AnnotationUI />);
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: /Annotate/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Tap anything')).toBeNull();
    const onLinkClick = vi.fn();
    document.getElementById('link')!.addEventListener('click', onLinkClick);
    await userEvent.click(document.getElementById('link')!);
    expect(onLinkClick).toHaveBeenCalled();
  });

  const touch = { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: 5, clientY: 5 };
  /** Hold a finger on #p past the long-press delay; true when it opened a new note. */
  function longPressOpensNote(): boolean {
    const p = document.getElementById('p')!;
    fireEvent.pointerDown(p, touch);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    fireEvent.pointerUp(p, touch);
    return screen.queryByRole('dialog', { name: 'New note' }) !== null;
  }

  it('long-press opens the sheet; without a host toggle, turning it off lasts for the page view only', async () => {
    page();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    try {
      const { unmount } = render(<AnnotationUI />);
      expect(longPressOpensNote()).toBe(true);
      // Past the window in which the release's own click is swallowed.
      act(() => {
        vi.advanceTimersByTime(600);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      fireEvent.click(screen.getByRole('button', { name: /Annotations,/ }));
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Long-press/ }));
      expect(longPressOpensNote()).toBe(false);
      unmount();

      // A new mount starts on again: nothing was kept in the browser.
      render(<AnnotationUI />);
      expect(longPressOpensNote()).toBe(true);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
      vi.useRealTimers();
    }
  });

  it('follows the host-kept long-press toggle and reports changes to it', async () => {
    page();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onChange = vi.fn();
      const { rerender } = render(
        <FixFast client={client} path="/" context={hostContext} longPress={{ enabled: false, onChange }} />
      );
      expect(longPressOpensNote()).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: /Annotations,/ }));
      const toggle = screen.getByRole('menuitemcheckbox', { name: /Long-press/ });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
      fireEvent.click(toggle);
      expect(onChange).toHaveBeenCalledWith(true);

      rerender(
        <FixFast client={client} path="/" context={hostContext} longPress={{ enabled: true, onChange }} />
      );
      expect(longPressOpensNote()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('⌘-click picks an element without activating it', async () => {
    page();
    const onLinkClick = vi.fn();
    document.getElementById('link')!.addEventListener('click', onLinkClick);
    render(<AnnotationUI />);
    await screen.findByRole('button', { name: /Annotations,/ });
    const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
    fireEvent.click(document.getElementById('link')!, mac ? { metaKey: true } : { ctrlKey: true });
    expect(onLinkClick).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New note' })).toBeInTheDocument();
  });
});

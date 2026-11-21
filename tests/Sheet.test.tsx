import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import Sheet, { SheetControlContext } from '../src/Sheet';

function renderSheet() {
  const onClose = vi.fn();
  render(
    <Sheet label="Test sheet" title={<span>Heading</span>} onClose={onClose}>
      <p>Body</p>
    </Sheet>
  );
  const head = screen.getByText('Heading').closest('.ann-sheet-head')!;
  return { onClose, head };
}

const at = (y: number) => ({ pointerId: 1, clientX: 100, clientY: y, pointerType: 'touch' });

describe('annotation Sheet', () => {
  it('closes on a swipe down past the threshold', () => {
    const { onClose, head } = renderSheet();
    fireEvent.pointerDown(head, at(100));
    fireEvent.pointerMove(head, at(150));
    expect(screen.getByRole('dialog', { name: 'Test sheet' }).style.transform).toBe('translateY(50px)');
    fireEvent.pointerMove(head, at(200));
    fireEvent.pointerUp(head, at(200));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('snaps back on a short swipe', () => {
    const { onClose, head } = renderSheet();
    fireEvent.pointerDown(head, at(100));
    fireEvent.pointerMove(head, at(140));
    fireEvent.pointerUp(head, at(140));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Test sheet' }).style.transform).toBe('');
  });

  it('closes on the close button', () => {
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('routes a swipe-down through the layer, which may hold it to protect a draft', () => {
    const onClose = vi.fn();
    const control = { requestDismiss: vi.fn(), discardPrompt: true, onKeepEditing: vi.fn(), onDiscard: vi.fn() };
    render(
      <SheetControlContext.Provider value={control}>
        <Sheet label="Test sheet" title={<span>Heading</span>} onClose={onClose}>
          <p>Body</p>
        </Sheet>
      </SheetControlContext.Provider>
    );
    const head = screen.getByText('Heading').closest('.ann-sheet-head')!;
    fireEvent.pointerDown(head, at(100));
    fireEvent.pointerUp(head, at(300));
    expect(control.requestDismiss).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Discard note?');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(control.onDiscard).toHaveBeenCalled();
  });

  it('returns focus to where it was when the sheet closes', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <Sheet label="Test sheet" title="t" onClose={() => {}}>
        <input aria-label="inside" autoFocus />
      </Sheet>
    );
    expect(document.activeElement).toBe(screen.getByLabelText('inside'));
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('sits on top of the on-screen keyboard reported by visualViewport', () => {
    const listeners: Record<string, () => void> = {};
    const vv = {
      height: 844,
      offsetTop: 0,
      addEventListener: (type: string, fn: () => void) => {
        listeners[type] = fn;
      },
      removeEventListener: () => {},
    };
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    try {
      renderSheet();
      const sheet = screen.getByRole('dialog', { name: 'Test sheet' });
      expect(sheet.style.getPropertyValue('--ann-kb')).toBe('0px');
      expect(sheet).not.toHaveAttribute('data-keyboard');
      vv.height = 508; // keyboard of 336 px opens
      listeners.resize();
      expect(sheet.style.getPropertyValue('--ann-kb')).toBe('336px');
      expect(sheet.style.getPropertyValue('--ann-vvh')).toBe('508px');
      // No safe-area padding under the sheet while the keyboard is up.
      expect(sheet).toHaveAttribute('data-keyboard');
      vv.height = 844;
      listeners.resize();
      expect(sheet).not.toHaveAttribute('data-keyboard');
    } finally {
      Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
    }
  });
});

describe('annotation Sheet focus', () => {
  const original = window.matchMedia;
  /** `wide`: the ≥ 768 px side-panel layout. */
  function viewport(wide: boolean) {
    window.matchMedia = ((query: string) => ({
      matches: wide && query.includes('min-width: 768px'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }
  afterEach(() => {
    window.matchMedia = original;
    document.body.innerHTML = '';
  });

  function FormSheet({ autoFocus = false }: { autoFocus?: boolean }) {
    return (
      <Sheet label="Form" title={<span>Heading</span>} onClose={() => {}}>
        <textarea aria-label="Note" autoFocus={autoFocus} />
        <button type="button">Save</button>
      </Sheet>
    );
  }

  it('moves focus into the sheet on open and back to the opener on close', () => {
    viewport(false);
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<FormSheet />);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
  });

  it('leaves focus where a child put it, such as the note textarea', () => {
    viewport(false);
    render(<FormSheet autoFocus />);
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveFocus();
  });

  it('keeps Tab and Shift-Tab inside the bottom sheet', () => {
    viewport(false);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    render(<FormSheet />);
    const dialog = screen.getByRole('dialog', { name: 'Form' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const close = screen.getByRole('button', { name: 'Close' });
    const save = screen.getByRole('button', { name: 'Save' });

    save.focus();
    expect(fireEvent.keyDown(save, { key: 'Tab' })).toBe(false);
    expect(close).toHaveFocus();
    expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(save).toHaveFocus();
    // From the middle, Tab moves on natively.
    const box = screen.getByRole('textbox', { name: 'Note' });
    box.focus();
    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(true);
    // Focus that escaped to the page comes back in.
    outside.focus();
    fireEvent.keyDown(outside, { key: 'Tab' });
    expect(close).toHaveFocus();
  });

  it('does not trap focus in the side panel, which sits beside a usable page', () => {
    viewport(true);
    render(<FormSheet />);
    expect(screen.getByRole('dialog', { name: 'Form' })).toHaveAttribute('aria-modal', 'false');
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    expect(fireEvent.keyDown(save, { key: 'Tab' })).toBe(true);
    expect(save).toHaveFocus();
  });
});

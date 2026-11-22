import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { fakeClient, makeLayer } from './helpers';
import PinMenu from '../src/PinMenu';

const client = fakeClient();
const Layer = makeLayer(client, { path: '/' });

const fab = () => screen.getByRole('button', { name: /Annotations,/ });
const item = (name: RegExp) => screen.getByRole('menuitem', { name });
const longPress = () => screen.getByRole('menuitemcheckbox', { name: /Long-press/ });

async function renderLayer() {
  render(<Layer />);
  await screen.findByRole('button', { name: /Annotations,/ });
}

/** Open the menu from the keyboard: Enter on the focused pin button. */
async function openWithKeyboard() {
  fab().focus();
  await userEvent.keyboard('{Enter}');
}

describe('pin button menu (menu-button pattern)', () => {
  let appEscape: () => void;
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && appEscape();
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    client.list.mockReset();
    client.list.mockResolvedValue([]);
    appEscape = vi.fn();
    window.addEventListener('keydown', onKey);
  });
  afterEach(() => window.removeEventListener('keydown', onKey));

  it('has menu-button roles and keeps items out of the tab order', async () => {
    await renderLayer();
    expect(fab()).toHaveAttribute('aria-haspopup', 'menu');
    expect(fab()).toHaveAttribute('aria-expanded', 'false');
    await openWithKeyboard();
    const menu = screen.getByRole('menu', { name: 'Annotations' });
    expect(fab()).toHaveAttribute('aria-expanded', 'true');
    expect(fab()).toHaveAttribute('aria-controls', menu.id);
    expect(longPress()).toHaveAttribute('aria-checked', 'true');
    for (const el of [item(/Annotate/), item(/Draw/), item(/Notes on this page/), longPress()]) {
      expect(el).toHaveAttribute('tabindex', '-1');
    }
  });

  it('a keyboard open focuses the first item; arrows wrap, Home and End jump', async () => {
    await renderLayer();
    await openWithKeyboard();
    expect(item(/Annotate/)).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(item(/Draw/)).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}{ArrowUp}');
    expect(longPress()).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(item(/Annotate/)).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(longPress()).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(item(/Annotate/)).toHaveFocus();
  });

  it('ArrowUp on the pin button opens the menu on its last item', async () => {
    await renderLayer();
    fab().focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(longPress()).toHaveFocus();
  });

  it('a pointer open focuses the menu itself, not an item, and the arrows still work', async () => {
    await renderLayer();
    await userEvent.click(fab());
    const menu = screen.getByRole('menu', { name: 'Annotations' });
    expect(menu).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(item(/Annotate/)).toHaveFocus();
  });

  it('Escape closes the menu and returns focus to the pin button, without reaching the app', async () => {
    await renderLayer();
    await openWithKeyboard();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(fab()).toHaveFocus();
    expect(appEscape).not.toHaveBeenCalled();
  });

  it('Tab closes the menu and returns focus to the pin button', async () => {
    await renderLayer();
    await openWithKeyboard();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.tab();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(fab()).toHaveFocus();
  });

  it('Annotate closes the menu and returns focus to the pin button', async () => {
    await renderLayer();
    await openWithKeyboard();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('Tap anything')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(fab()).toHaveFocus();
  });

  it('the long-press toggle keeps the menu open with focus on it', async () => {
    await renderLayer();
    await openWithKeyboard();
    await userEvent.keyboard('{End}{Enter}');
    expect(longPress()).toHaveAttribute('aria-checked', 'false');
    expect(longPress()).toHaveFocus();
  });

  it('Draw from the keyboard focuses the drawing toolbar, and leaving it returns to the pin button', async () => {
    await renderLayer();
    await openWithKeyboard();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    // Undo and Clear are disabled until something is drawn.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('toolbar', { name: 'Drawing' })).toBeNull();
    expect(fab()).toHaveFocus();
  });

  it('Notes on this page hands focus to the sheet', async () => {
    await renderLayer();
    await openWithKeyboard();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(screen.getByRole('dialog', { name: 'Notes on this page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});

describe('PinMenu focus on open', () => {
  it('moves focus once, and later renders leave it where the user put it', () => {
    const { rerender } = render(
      <PinMenu id="m" label="Menu" initialFocus="first" onTabOut={() => {}}>
        <button role="menuitem">One</button>
        <button role="menuitem">Two</button>
      </PinMenu>
    );
    expect(screen.getByRole('menuitem', { name: 'One' })).toHaveFocus();

    screen.getByRole('menuitem', { name: 'One' }).blur();
    expect(document.body).toHaveFocus();
    rerender(
      <PinMenu id="m" label="Menu" initialFocus="last" onTabOut={() => {}} error="Try again">
        <button role="menuitem">One</button>
        <button role="menuitem">Two</button>
      </PinMenu>
    );
    expect(document.body).toHaveFocus();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { FixFast } from '../src/FixFast';
import {
  DONE_PIN_KEEP_MS,
  DONE_PIN_MAX_VIEWS,
  DONE_PINS_STORAGE_KEY,
  loadDonePins,
  prunedDonePins,
  updateDonePins,
  withViews,
} from '../src/donePins';
import type { AnnotateStorage, AnnotationItem, AnnotationStatus } from '../src/types';
import { fakeClient, hostContext } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const CLOSED = new Date(Date.now() - DAY).toISOString();

function mapStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: AnnotateStorage = {
    get: vi.fn((key: string) => data.get(key) ?? null),
    set: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
  return { storage, data };
}

function stored(data: Map<string, string>) {
  return JSON.parse(data.get(DONE_PINS_STORAGE_KEY) ?? '{}');
}

function note(number: number, status: AnnotationStatus, annId: string, closedAt: string | null = null): AnnotationItem {
  return {
    number,
    html_url: `https://github.com/o/r/issues/${number}`,
    title: '',
    text: `Note ${number}`,
    type: 'bug',
    status,
    anchor: { path: '/', url: '', ann_id: annId, css_path: '' },
    created_at: '',
    updated_at: '',
    closed_at: closedAt,
    author: 'a',
  };
}

function page() {
  document.body.innerHTML = `
    <div data-ann="one" data-ann-unique>First</div>
    <div data-ann="two" data-ann-unique>Second</div>
    <div data-ann="three" data-ann-unique>Third</div>`;
  ['one', 'two', 'three'].forEach((name, i) => {
    const el = document.querySelector(`[data-ann="${name}"]`)!;
    const top = 100 + i * 100;
    el.getBoundingClientRect = () =>
      ({ left: 20, top, right: 220, bottom: top + 40, width: 200, height: 40, x: 20, y: top, toJSON() {} }) as DOMRect;
  });
}

const client = fakeClient();

function setup(storage: AnnotateStorage | undefined, path = '/a') {
  const view = (p: string) => <FixFast client={client} path={p} context={hostContext} storage={storage} />;
  const result = render(view(path));
  return { ...result, navigate: (p: string) => result.rerender(view(p)) };
}

const pin = (number: number, status = 'Done') => screen.queryByRole('button', { name: `Note #${number}, ${status}` });

async function openList() {
  await userEvent.click(await screen.findByRole('button', { name: /Annotations,/ }));
  await userEvent.click(screen.getByRole('menuitem', { name: /Notes on this page/ }));
  return screen.getByRole('dialog', { name: 'Notes on this page' });
}

describe('done pins', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    page();
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    client.list.mockReset();
    client.setStatus.mockReset();
  });

  it('counts a view once per page view, however often the pins re-render', async () => {
    const { storage, data } = mapStorage();
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED)]);
    const { navigate } = setup(storage);
    expect(await screen.findByRole('button', { name: 'Note #3, Done' })).toBeInTheDocument();
    // Pins report what is on screen from an effect, which can run after the pin is found.
    await waitFor(() => expect(stored(data)).toEqual({ [`3@${CLOSED}`]: { views: 1 } }));

    // Opening the list refetches and re-renders the pins: same page view.
    await openList();
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(pin(3)).toBeInTheDocument();
    expect(stored(data)[`3@${CLOSED}`].views).toBe(1);

    navigate('/b');
    await waitFor(() => expect(stored(data)[`3@${CLOSED}`].views).toBe(2));
  });

  it('does not count a done note that has no pin on screen', async () => {
    const { storage, data } = mapStorage();
    const offscreen = { ...note(4, 'done', 'missing', CLOSED) };
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED), offscreen]);
    setup(storage);
    await screen.findByRole('button', { name: 'Note #3, Done' });
    await waitFor(() => expect(Object.keys(stored(data))).toEqual([`3@${CLOSED}`]));
  });

  it(`shows a pin on ${DONE_PIN_MAX_VIEWS} page views, keeping it through the last one`, async () => {
    const { storage, data } = mapStorage();
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED)]);
    const { navigate } = setup(storage, '/p1');
    await screen.findByRole('button', { name: 'Note #3, Done' });
    for (let view = 2; view <= DONE_PIN_MAX_VIEWS; view++) {
      navigate(`/p${view}`);
      await waitFor(() => expect(stored(data)[`3@${CLOSED}`].views).toBe(view));
      expect(pin(3)).toBeInTheDocument();
    }
    // A refetch in the 7th page view leaves the pin where it is.
    await openList();
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(DONE_PIN_MAX_VIEWS + 1));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(pin(3)).toBeInTheDocument();

    navigate('/next');
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith('/next', { fresh: false }));
    await screen.findByRole('button', { name: 'Annotations, 0 open on this page' });
    expect(pin(3)).not.toBeInTheDocument();
    // The note itself stays in the list, with Reopen.
    const list = await openList();
    await userEvent.click(within(list).getByRole('button', { name: /Note 3/ }));
    expect(within(list).getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
  });

  it('a worn-out pin does not show on mount', async () => {
    const { storage } = mapStorage({
      [DONE_PINS_STORAGE_KEY]: JSON.stringify({ [`3@${CLOSED}`]: { views: DONE_PIN_MAX_VIEWS } }),
    });
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED), note(5, 'open', 'two')]);
    setup(storage);
    expect(await screen.findByRole('button', { name: 'Note #5, Open' })).toBeInTheDocument();
    expect(pin(3)).not.toBeInTheDocument();
  });

  it('"Hide pin" removes a done pin at once and keeps it hidden', async () => {
    const { storage, data } = mapStorage();
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED)]);
    const { navigate } = setup(storage);
    await userEvent.click(await screen.findByRole('button', { name: 'Note #3, Done' }));
    const sheet = screen.getByRole('dialog', { name: 'Note #3' });
    expect(within(sheet).getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Hide pin' }));
    expect(pin(3)).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Note #3' })).not.toBeInTheDocument();
    expect(stored(data)[`3@${CLOSED}`]).toEqual({ views: 1, hidden: true });

    navigate('/b');
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith('/b', { fresh: false }));
    await screen.findByRole('button', { name: /Annotations,/ });
    expect(pin(3)).not.toBeInTheDocument();
  });

  it('"Hide done pins" removes every done pin and leaves open and working ones', async () => {
    const { storage, data } = mapStorage();
    client.list.mockResolvedValue([
      note(3, 'done', 'one', CLOSED),
      note(4, 'done', 'two', CLOSED),
      note(5, 'open', 'three'),
      note(6, 'working', 'three'),
    ]);
    setup(storage);
    await screen.findByRole('button', { name: 'Note #4, Done' });
    const list = await openList();
    await userEvent.click(within(list).getByRole('button', { name: 'Hide done pins' }));
    expect(within(list).getAllByRole('button', { name: /^Note \d/ })[0]).toHaveFocus();
    expect(within(list).getByRole('status')).toHaveTextContent('Done pins hidden');
    expect(pin(3)).not.toBeInTheDocument();
    expect(pin(4)).not.toBeInTheDocument();
    expect(pin(5, 'Open')).toBeInTheDocument();
    expect(pin(6, 'Working')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: 'Hide done pins' })).not.toBeInTheDocument();
    expect(within(list).getByText('Note 3')).toBeInTheDocument();
    expect(Object.keys(stored(data)).sort()).toEqual([`3@${CLOSED}`, `4@${CLOSED}`]);
    expect(Object.values(stored(data)).every((e) => (e as { hidden?: boolean }).hidden)).toBe(true);
  });

  it('offers no "Hide done pins" without a done pin on the page', async () => {
    const { storage } = mapStorage();
    client.list.mockResolvedValue([note(5, 'open', 'one')]);
    setup(storage);
    await screen.findByRole('button', { name: 'Note #5, Open' });
    const list = await openList();
    expect(within(list).queryByRole('button', { name: 'Hide done pins' })).not.toBeInTheDocument();
  });

  it('a note closed again shows fresh: state is per closing', async () => {
    const earlier = new Date(Date.now() - 3 * DAY).toISOString();
    const { storage } = mapStorage({
      [DONE_PINS_STORAGE_KEY]: JSON.stringify({ [`3@${earlier}`]: { views: DONE_PIN_MAX_VIEWS, hidden: true } }),
    });
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED)]);
    setup(storage);
    expect(await screen.findByRole('button', { name: 'Note #3, Done' })).toBeInTheDocument();
  });

  it('open and working notes are never counted or hidden', async () => {
    const { storage, data } = mapStorage();
    client.list.mockResolvedValue([note(5, 'open', 'one'), note(6, 'working', 'two')]);
    const { navigate } = setup(storage, '/p0');
    await screen.findByRole('button', { name: 'Note #5, Open' });
    for (let view = 1; view <= DONE_PIN_MAX_VIEWS + 1; view++) {
      navigate(`/p${view}`);
      await waitFor(() => expect(client.list).toHaveBeenLastCalledWith(`/p${view}`, { fresh: false }));
    }
    expect(await screen.findByRole('button', { name: 'Note #5, Open' })).toBeInTheDocument();
    expect(pin(6, 'Working')).toBeInTheDocument();
    expect(data.has(DONE_PINS_STORAGE_KEY)).toBe(false);
    await userEvent.click(pin(5, 'Open')!);
    expect(screen.queryByRole('button', { name: 'Hide pin' })).not.toBeInTheDocument();
  });

  it('a done note without closed_at keeps its pin and offers no hide', async () => {
    const { storage, data } = mapStorage();
    client.list.mockResolvedValue([note(3, 'done', 'one', null)]);
    setup(storage);
    await userEvent.click(await screen.findByRole('button', { name: 'Note #3, Done' }));
    expect(screen.queryByRole('button', { name: 'Hide pin' })).not.toBeInTheDocument();
    expect(data.has(DONE_PINS_STORAGE_KEY)).toBe(false);
  });

  it('when the storage throws, done pins show as the server lists them and hiding still works', async () => {
    const storage: AnnotateStorage = {
      get: () => {
        throw new Error('blocked');
      },
      set: () => {
        throw new Error('blocked');
      },
    };
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED), note(4, 'done', 'two', CLOSED)]);
    const { navigate } = setup(storage, '/p0');
    await screen.findByRole('button', { name: 'Note #3, Done' });
    for (let view = 1; view <= DONE_PIN_MAX_VIEWS + 1; view++) {
      navigate(`/p${view}`);
      await waitFor(() => expect(client.list).toHaveBeenLastCalledWith(`/p${view}`, { fresh: false }));
    }
    expect(await screen.findByRole('button', { name: 'Note #3, Done' })).toBeInTheDocument();
    await userEvent.click(pin(4)!);
    await userEvent.click(screen.getByRole('button', { name: 'Hide pin' }));
    expect(pin(4)).not.toBeInTheDocument();
    expect(pin(3)).toBeInTheDocument();
  });

  it('a storage that throws on every key still mounts the layer, and long-press works', async () => {
    const storage: AnnotateStorage = {
      get: () => {
        throw new Error('blocked');
      },
      set: () => {
        throw new Error('blocked');
      },
    };
    client.list.mockResolvedValue([]);
    setup(storage);
    await userEvent.click(await screen.findByRole('button', { name: /Annotations,/ }));
    const toggle = screen.getByRole('menuitemcheckbox', { name: /Long-press/ });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('with the default storage, a localStorage that cannot be written leaves done pins showing', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED)]);
    const { navigate } = setup(undefined, '/p0');
    await screen.findByRole('button', { name: 'Note #3, Done' });
    for (let view = 1; view <= DONE_PIN_MAX_VIEWS + 1; view++) {
      navigate(`/p${view}`);
      await waitFor(() => expect(client.list).toHaveBeenLastCalledWith(`/p${view}`, { fresh: false }));
      expect(await screen.findByRole('button', { name: 'Note #3, Done' })).toBeInTheDocument();
    }
    // Hiding still works, and survives the next page view's reread.
    await userEvent.click(pin(3)!);
    await userEvent.click(screen.getByRole('button', { name: 'Hide pin' }));
    expect(pin(3)).not.toBeInTheDocument();
    navigate('/after');
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith('/after', { fresh: false }));
    await screen.findByRole('button', { name: /Annotations,/ });
    expect(pin(3)).not.toBeInTheDocument();
  });

  it('with the default storage, a localStorage that cannot be read still mounts with done pins', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED)]);
    setup(undefined);
    expect(await screen.findByRole('button', { name: 'Note #3, Done' })).toBeInTheDocument();
  });

  it('a pin hidden in another tab goes away at once', async () => {
    const { storage, data } = mapStorage();
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED), note(4, 'done', 'two', CLOSED)]);
    setup(storage);
    await screen.findByRole('button', { name: 'Note #4, Done' });
    data.set(DONE_PINS_STORAGE_KEY, JSON.stringify({ ...stored(data), [`3@${CLOSED}`]: { views: 1, hidden: true } }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: DONE_PINS_STORAGE_KEY }));
    });
    expect(pin(3)).not.toBeInTheDocument();
    expect(pin(4)).toBeInTheDocument();
  });

  it('a new page view rereads the storage: a pin hidden elsewhere neither shows nor counts', async () => {
    const { storage, data } = mapStorage();
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED)]);
    const { navigate } = setup(storage);
    await screen.findByRole('button', { name: 'Note #3, Done' });
    // The pin's own view is stored after it renders; the other tab's write comes after that.
    await waitFor(() => expect(stored(data)[`3@${CLOSED}`]).toEqual({ views: 1 }));
    // Another tab hid it, without an event reaching this one.
    data.set(DONE_PINS_STORAGE_KEY, JSON.stringify({ [`3@${CLOSED}`]: { views: 1, hidden: true } }));
    navigate('/b');
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith('/b', { fresh: false }));
    await screen.findByRole('button', { name: /Annotations,/ });
    expect(pin(3)).not.toBeInTheDocument();
    expect(stored(data)[`3@${CLOSED}`]).toEqual({ views: 1, hidden: true });
  });

  it("another tab's views do not take away a pin that is showing this page view", async () => {
    const { storage, data } = mapStorage();
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED)]);
    const { navigate } = setup(storage);
    await screen.findByRole('button', { name: 'Note #3, Done' });
    data.set(DONE_PINS_STORAGE_KEY, JSON.stringify({ [`3@${CLOSED}`]: { views: DONE_PIN_MAX_VIEWS } }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: DONE_PINS_STORAGE_KEY }));
    });
    expect(pin(3)).toBeInTheDocument();
    navigate('/b');
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith('/b', { fresh: false }));
    await screen.findByRole('button', { name: /Annotations,/ });
    expect(pin(3)).not.toBeInTheDocument();
  });

  it('when only writes fail, views stop counting and pins keep showing', async () => {
    const { storage, data } = mapStorage({
      [DONE_PINS_STORAGE_KEY]: JSON.stringify({ [`3@${CLOSED}`]: { views: DONE_PIN_MAX_VIEWS - 1 } }),
    });
    storage.set = () => {
      throw new Error('quota');
    };
    client.list.mockResolvedValue([note(3, 'done', 'one', CLOSED)]);
    const { navigate } = setup(storage);
    await screen.findByRole('button', { name: 'Note #3, Done' });
    navigate('/b');
    await waitFor(() => expect(client.list).toHaveBeenLastCalledWith('/b', { fresh: false }));
    expect(await screen.findByRole('button', { name: 'Note #3, Done' })).toBeInTheDocument();
    expect(stored(data)[`3@${CLOSED}`].views).toBe(DONE_PIN_MAX_VIEWS - 1);
  });
});

describe('donePins storage', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');

  it('reads a missing or malformed value as no entries, and drops malformed entries', () => {
    expect(loadDonePins(mapStorage().storage)).toEqual({});
    expect(loadDonePins(mapStorage({ [DONE_PINS_STORAGE_KEY]: '{oops' }).storage)).toEqual({});
    expect(loadDonePins(mapStorage({ [DONE_PINS_STORAGE_KEY]: '[1]' }).storage)).toEqual({});
    const value = JSON.stringify({ 'a@x': { views: 2 }, 'b@x': { views: 'many' }, 'c@x': null, 'd@x': { views: 1, hidden: 1 } });
    expect(loadDonePins(mapStorage({ [DONE_PINS_STORAGE_KEY]: value }).storage)).toEqual({ 'a@x': { views: 2 } });
  });

  it('prunes entries for notes closed more than 8 days ago, and unparseable keys', () => {
    const recent = new Date(now - DONE_PIN_KEEP_MS + 1000).toISOString();
    const old = new Date(now - DONE_PIN_KEEP_MS - 1000).toISOString();
    const entries = { [`1@${recent}`]: { views: 1 }, [`2@${old}`]: { views: 1 }, '3@nonsense': { views: 1 } };
    expect(prunedDonePins(entries, now)).toEqual({ [`1@${recent}`]: { views: 1 } });
  });

  it('writes merge with what another tab stored meanwhile', () => {
    const closed = new Date(now - DAY).toISOString();
    const { storage, data } = mapStorage({
      [DONE_PINS_STORAGE_KEY]: JSON.stringify({ [`9@${closed}`]: { views: 2, hidden: true } }),
    });
    const written = updateDonePins(storage, (e) => withViews(e, [`3@${closed}`, `9@${closed}`]), now);
    expect(written).toEqual({ [`9@${closed}`]: { views: 3, hidden: true }, [`3@${closed}`]: { views: 1 } });
    expect(stored(data)).toEqual(written);
  });
});

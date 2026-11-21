import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { fakeClient, makeLayer } from './helpers';
import { buildAnchor, textSnippet } from '../src/picker';

const nav = { path: '/' };
const client = fakeClient();
const listAnnotations = client.list;
const createAnnotation = client.create;
const setAnnotationStatus = client.setStatus;
const AnnotationUI = makeLayer(client, nav);

const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

function page() {
  const root = document.createElement('div');
  root.innerHTML = `<div data-ann="answer-body"><p id="p">Answer text</p></div>`;
  document.body.appendChild(root);
}

/** Stand-in for an app modal's Escape handler (a details modal, a settings modal). */
function appEscapeListener() {
  const onEscape = vi.fn();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onEscape();
  };
  window.addEventListener('keydown', onKey);
  return { onEscape, remove: () => window.removeEventListener('keydown', onKey) };
}

async function openSheet() {
  await screen.findByRole('button', { name: /Annotations,/ });
  pick();
  return screen.getByRole('dialog', { name: 'New note' });
}

/** Navigation closes the sheet and keeps its draft in sessionStorage. */
function leaveAndComeBack(rerender: (ui: React.ReactElement) => void) {
  nav.path = '/faq';
  rerender(<AnnotationUI />);
  nav.path = '/';
  rerender(<AnnotationUI />);
}

function pick() {
  fireEvent.click(document.getElementById('p')!, MAC ? { metaKey: true } : { ctrlKey: true });
}

describe('AnnotateLayer dismissal and drafts', () => {
  let app: ReturnType<typeof appEscapeListener>;

  beforeEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
    nav.path = '/';
    Element.prototype.scrollIntoView = vi.fn();
    listAnnotations.mockReset();
    listAnnotations.mockResolvedValue([]);
    createAnnotation.mockReset();
    setAnnotationStatus.mockReset();
    page();
    app = appEscapeListener();
  });
  afterEach(() => app.remove());

  it('adds no popstate listener and no history entries', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const depth = window.history.length;
    const state = window.history.state;
    render(<AnnotationUI />);
    await openSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Draft');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await userEvent.click(screen.getByRole('button', { name: /Annotations,/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Notes on this page/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(add.mock.calls.some(([type]) => type === 'popstate')).toBe(false);
    expect(window.history.length).toBe(depth);
    expect(window.history.state).toBe(state);
    add.mockRestore();
  });

  it('Escape closes the sheet without reaching the app modal underneath', async () => {
    render(<AnnotationUI />);
    await openSheet();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Note' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
    expect(app.onEscape).not.toHaveBeenCalled();
  });

  it('asks before Escape discards a draft, and the second Escape discards it for good', async () => {
    render(<AnnotationUI />);
    await openSheet();
    const box = screen.getByRole('textbox', { name: 'Note' });
    await userEvent.type(box, 'Chip label is wrong');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.getByRole('alert')).toHaveTextContent('Discard note?');
    expect(box).toHaveValue('Chip label is wrong');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
    expect(app.onEscape).not.toHaveBeenCalled();
    pick();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });

  it('Cancel asks before discarding a draft, like Escape, and closes an empty sheet at once', async () => {
    render(<AnnotationUI />);
    await openSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();

    pick();
    const box = screen.getByRole('textbox', { name: 'Note' });
    await userEvent.type(box, 'Half-written note');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Discard note?');
    expect(box).toHaveValue('Half-written note');
    // A second Cancel discards, as a second Escape does.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
    pick();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });

  it('the close button asks before discarding a draft, and closes an empty sheet at once', async () => {
    render(<AnnotationUI />);
    await openSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();

    pick();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Half-written');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Discard note?');
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Half-written');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
    pick();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });

  it('Keep editing clears the prompt and keeps the draft', async () => {
    render(<AnnotationUI />);
    await openSheet();
    const box = screen.getByRole('textbox', { name: 'Note' });
    await userEvent.type(box, 'Draft');
    fireEvent.keyDown(box, { key: 'Escape' });
    await userEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText(/Discard note\?/)).toBeNull();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.getByRole('alert')).toHaveTextContent('Discard note?');
  });

  it('restores the draft text and type when the same element is picked again', async () => {
    const { rerender } = render(<AnnotationUI />);
    await openSheet();
    await userEvent.click(screen.getByRole('radio', { name: 'Design' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Too much padding');
    // Closed without discarding: the admin navigates away and back.
    leaveAndComeBack(rerender);
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();

    pick();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Too much padding');
    expect(screen.getByRole('radio', { name: 'Design' })).toHaveAttribute('aria-checked', 'true');
    // A restored draft is still protected by the discard prompt.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('alert')).toHaveTextContent('Discard note?');
  });

  it('keeps drafts apart for repeated data-ann names, such as two answers', async () => {
    const second = document.createElement('div');
    second.innerHTML = '<div data-ann="answer-body"><p id="p2">Second answer</p></div>';
    document.body.appendChild(second);
    const pickEl = (id: string) =>
      fireEvent.click(document.getElementById(id)!, MAC ? { metaKey: true } : { ctrlKey: true });

    const { rerender } = render(<AnnotationUI />);
    await openSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'About the first answer');
    leaveAndComeBack(rerender);

    pickEl('p2');
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    pickEl('p');
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('About the first answer');
  });

  it('keeps a feedback-row draft on its own answer when messages shift, and keeps it stored', async () => {
    const message = (n: number) => {
      const m = document.createElement('div');
      m.setAttribute('data-ann', 'message');
      m.innerHTML = `<p>Answer ${n} about billing</p><div data-ann="feedback-buttons"><button id="fb${n}">Helpful?</button></div>`;
      return m;
    };
    document.body.innerHTML = '';
    const first = message(1);
    document.body.append(first, message(2), message(3));
    const pickRow = (n: number) => fireEvent.click(document.getElementById(`fb${n}`)!, MAC ? { metaKey: true } : { ctrlKey: true });

    const { rerender } = render(<AnnotationUI />);
    await screen.findByRole('button', { name: /Annotations,/ });
    pickRow(1);
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Row on answer 1');
    leaveAndComeBack(rerender);

    // Answer 1 goes away: answer 2's row now has its index, CSS path and text.
    first.remove();
    pickRow(2);
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(Object.values(sessionStorage).some((v) => v.includes('Row on answer 1'))).toBe(true);

    // Answer 1 loads again above the others: its draft comes back.
    document.body.insertBefore(first, document.body.firstChild);
    pickRow(1);
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Row on answer 1');
  });

  describe('drafts on repeated elements whose index changes', () => {
    const answer = (id: string, text: string) => {
      const a = document.createElement('div');
      a.setAttribute('data-ann', 'answer-body');
      a.innerHTML = `<p id="${id}">${text}</p>`;
      return a;
    };
    const pickId = (id: string) =>
      fireEvent.click(document.getElementById(id)!, MAC ? { metaKey: true } : { ctrlKey: true });
    const drafts = () => Object.entries(sessionStorage).filter(([k]) => k.startsWith('ann:draft:'));

    const intro = 'Thanks for your question. Here is a summary of the relevant documentation: ';
    const long = (rest: string) => intro + rest + ' '.repeat(1) + 'More detail follows here. '.repeat(6);

    it('restores a draft started on a half-streamed answer once the answer has grown', async () => {
      document.body.innerHTML = '';
      document.body.append(answer('one', 'An earlier, finished answer about billing cycles.'), answer('two', 'Invoices are sent'));
      const { rerender } = render(<AnnotationUI />);
      await screen.findByRole('button', { name: /Annotations,/ });
      pickId('two');
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Check the nisab');
      leaveAndComeBack(rerender);

      document.getElementById('two')!.textContent += ' due once a year when it reaches the nisab. ' + 'More detail. '.repeat(20);
      pickId('two');
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Check the nisab');
    });

    it('never swaps drafts between answers that share a long introduction', async () => {
      document.body.innerHTML = '';
      document.body.append(answer('one', long('password reset links expire after an hour.')), answer('two', long('invoices are sent monthly.')));
      const { rerender } = render(<AnnotationUI />);
      await screen.findByRole('button', { name: /Annotations,/ });
      pickId('one');
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'About billing');
      leaveAndComeBack(rerender);

      // Reordered: answer two now holds answer one's index (and its draft key).
      document.body.prepend(document.getElementById('two')!.parentElement!);
      pickId('two');
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
      leaveAndComeBack(rerender);
      pickId('one');
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('About billing');
    });

    it('does not hand a draft started on the shared introduction to the other answer after a reorder', async () => {
      document.body.innerHTML = '';
      document.body.append(answer('one', long('password reset links expire after an hour.')), answer('two', intro.trim()));
      const { rerender } = render(<AnnotationUI />);
      await screen.findByRole('button', { name: /Annotations,/ });
      pickId('two');
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'About invoices');
      leaveAndComeBack(rerender);

      // Answer two finishes streaming, then the answers swap places. Only the
      // introduction was stored, which both answers start with.
      document.getElementById('two')!.textContent = long('invoices are sent monthly.');
      document.body.prepend(document.getElementById('two')!.parentElement!);
      pickId('one');
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
    });

    it('finds a draft again after an older answer loads above, and moves it to the new key', async () => {
      document.body.innerHTML = '';
      document.body.append(answer('one', 'First answer'), answer('two', 'Second answer'));
      const { rerender } = render(<AnnotationUI />);
      await screen.findByRole('button', { name: /Annotations,/ });
      pickId('two');
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'On the second answer');
      leaveAndComeBack(rerender);

      document.body.prepend(answer('zero', 'An older answer'));
      pickId('two');
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('On the second answer');
      expect(drafts().map(([k]) => k)).toEqual(['ann:draft:/|answer-body|2']);
    });

    it('never moves a unique element\'s draft onto another unique element with the same text', async () => {
      // The composer's other controls are icon-only, so its text is the plan switcher's.
      document.body.innerHTML = `
        <div data-ann="composer" data-ann-unique><button id="composer-icon" aria-label="Attach"><svg></svg></button>
          <div data-ann="plan-switcher" data-ann-unique><button id="switcher">Pro plan</button></div>
        </div>`;
      const composer = document.querySelector('[data-ann="composer"]')!;
      const switcher = document.querySelector('[data-ann="plan-switcher"]')!;
      expect(textSnippet(composer)).toBe(textSnippet(switcher));
      const pick = (el: Element) => fireEvent.click(el, MAC ? { metaKey: true } : { ctrlKey: true });

      const { rerender } = render(<AnnotationUI />);
      await screen.findByRole('button', { name: /Annotations,/ });
      pick(document.getElementById('composer-icon')!);
      expect(screen.getByRole('button', { name: 'composer' })).toHaveAttribute('aria-pressed', 'true');
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'About the composer');
      leaveAndComeBack(rerender);

      pick(document.getElementById('switcher')!);
      expect(screen.getByRole('button', { name: 'plan-switcher' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(drafts().map(([k]) => k)).toEqual(['ann:draft:/|composer|0']);

      pick(document.getElementById('composer-icon')!);
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('About the composer');
    });

    it('checks the name on the current key as well', async () => {
      document.body.innerHTML = `
        <div data-ann="composer" data-ann-unique><button aria-label="Attach"><svg></svg></button>
          <div data-ann="plan-switcher" data-ann-unique><button id="switcher">Pro plan</button></div>
        </div>`;
      const composer = document.querySelector('[data-ann="composer"]')!;
      // A composer draft sitting under the switcher's key.
      sessionStorage.setItem(
        'ann:draft:/|plan-switcher|0',
        JSON.stringify({ text: 'About the composer', type: 'bug', snippet: textSnippet(composer), anchor: buildAnchor(composer, '/', 'u') })
      );
      render(<AnnotationUI />);
      await screen.findByRole('button', { name: /Annotations,/ });
      fireEvent.click(document.getElementById('switcher')!, MAC ? { metaKey: true } : { ctrlKey: true });
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
    });

    it("never takes over another element's draft", async () => {
      document.body.innerHTML = '';
      document.body.append(answer('one', 'First answer'));
      const { rerender } = render(<AnnotationUI />);
      await screen.findByRole('button', { name: /Annotations,/ });
      pickId('one');
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'On the first answer');
      leaveAndComeBack(rerender);

      // An older answer takes index 0, where the first answer's draft is stored.
      document.body.prepend(answer('zero', 'An older answer'));
      pickId('zero');
      const box = screen.getByRole('textbox', { name: 'Note' });
      expect(box).toHaveValue('');
      await userEvent.type(box, 'On the older answer');
      leaveAndComeBack(rerender);
      expect(drafts().some(([, v]) => v.includes('On the first answer'))).toBe(true);

      pickId('one');
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('On the first answer');
      leaveAndComeBack(rerender);
      pickId('zero');
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('On the older answer');
    });
  });

  it('does not restore a draft onto a different element that took over its index', async () => {
    const { rerender } = render(<AnnotationUI />);
    await openSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'About the answer text');
    leaveAndComeBack(rerender);

    // Older messages load above: a new first answer-body appears.
    const older = document.createElement('div');
    older.innerHTML = '<div data-ann="answer-body"><p id="older">An older answer</p></div>';
    document.body.insertBefore(older, document.body.firstChild);
    fireEvent.click(document.getElementById('older')!, MAC ? { metaKey: true } : { ctrlKey: true });
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });

  it('keeps the text when the page changes under the open sheet', async () => {
    const plain = document.createElement('section');
    plain.id = 'plain';
    plain.textContent = 'Untagged paragraph';
    document.body.appendChild(plain);
    render(<AnnotationUI />);
    await screen.findByRole('button', { name: /Annotations,/ });
    fireEvent.click(plain, MAC ? { metaKey: true } : { ctrlKey: true });
    const box = screen.getByRole('textbox', { name: 'Note' });
    await userEvent.type(box, 'abc');

    // A sibling lands before the picked element (its CSS path changes) and a
    // same-named anchor lands before the first answer (its index changes).
    document.body.insertBefore(document.createElement('section'), plain);
    const extra = document.createElement('div');
    extra.setAttribute('data-ann', 'answer-body');
    document.body.insertBefore(extra, document.body.firstChild);

    await userEvent.type(box, 'def');
    expect(screen.getByRole('textbox', { name: 'Note' })).toBe(box);
    expect(box).toHaveValue('abcdef');
  });

  it('a slow save finishing later leaves the sheet the admin moved to, and leaves no draft', async () => {
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
    let resolve: (v: unknown) => void = () => {};
    createAnnotation.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<AnnotationUI />);
    await screen.findByRole('button', { name: 'Note #5, Open' });
    pick();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Second note here');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // While saving: Close, Escape and swipe do nothing.
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toBeDisabled();
    fireEvent.click(close);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'New note' })).toBeInTheDocument();

    // A pin tap moves on to another sheet before the save returns.
    await userEvent.click(screen.getByRole('button', { name: 'Note #5, Open' }));
    expect(screen.getByRole('dialog', { name: 'Note #5' })).toBeInTheDocument();
    await act(async () => resolve({ number: 9, html_url: 'u9', status: 'open', created_at: '' }));
    expect(screen.getByRole('dialog', { name: 'Note #5' })).toBeInTheDocument();
    expect(screen.getByText('Saved as')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    pick();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });

  it('a slow save does not close a newer sheet opened on the same element', async () => {
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
    let resolve: (v: unknown) => void = () => {};
    createAnnotation.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<AnnotationUI />);
    await screen.findByRole('button', { name: 'Note #5, Open' });
    pick();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'First note');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Away to the pin's note and back to the same element, with a new draft.
    await userEvent.click(screen.getByRole('button', { name: 'Note #5, Open' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    pick();
    const second = screen.getByRole('dialog', { name: 'New note' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Second note');

    await act(async () => resolve({ number: 9, html_url: 'u9', status: 'open', created_at: '' }));
    expect(screen.getByText('Saved as')).toBeInTheDocument();
    expect(second).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Second note');
  });

  it('a save that finishes after the admin changed page does not reload the old page', async () => {
    const faqNote = {
      number: 31, html_url: '', title: '', text: 'FAQ note', type: 'bug', status: 'open',
      anchor: { path: '/faq', url: '', css_path: '' }, created_at: '', updated_at: '', author: 'a',
    };
    listAnnotations.mockImplementation(async (path: string) => (path === '/faq' ? [faqNote] : []));
    let resolve: (v: unknown) => void = () => {};
    createAnnotation.mockReturnValue(new Promise((r) => (resolve = r)));

    const { rerender } = render(<AnnotationUI />);
    await openSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Slow note');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    nav.path = '/faq';
    rerender(<AnnotationUI />);
    expect(await screen.findByRole('button', { name: 'Annotations, 1 open on this page' })).toBeInTheDocument();
    listAnnotations.mockClear();

    await act(async () => resolve({ number: 40, html_url: 'u', status: 'open', created_at: '' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(listAnnotations.mock.calls.some(([p]) => p === '/')).toBe(false);
    expect(screen.getByRole('button', { name: 'Annotations, 1 open on this page' })).toBeInTheDocument();
  });

  it('clears the discard prompt when a save starts', async () => {
    createAnnotation.mockReturnValue(new Promise(() => {}));
    render(<AnnotationUI />);
    await openSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Draft');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByText(/Discard note\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByText(/Discard note\?/)).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText(/Discard note\?/)).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New note' })).toBeInTheDocument();
  });

  it('a save that fails after the admin discarded a newer draft for the element does not bring the text back', async () => {
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
    let reject: (e: unknown) => void = () => {};
    createAnnotation.mockReturnValue(new Promise((_, r) => (reject = r)));
    render(<AnnotationUI />);
    await screen.findByRole('button', { name: 'Note #5, Open' });
    pick();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'First attempt');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // Move away, come back to the same element, write and discard a draft.
    await userEvent.click(screen.getByRole('button', { name: 'Note #5, Open' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    pick();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Second thoughts');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();

    await act(async () => reject(new Error('network')));
    expect(screen.getByRole('alert')).toHaveTextContent(/^Note not saved\. Annotations failed: network$/);
    pick();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });

  it('a save that fails after the admin moved to another sheet says so and keeps the text', async () => {
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
    let reject: (e: unknown) => void = () => {};
    createAnnotation.mockReturnValue(new Promise((_, r) => (reject = r)));
    render(<AnnotationUI />);
    await screen.findByRole('button', { name: 'Note #5, Open' });
    pick();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Lost note');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await userEvent.click(screen.getByRole('button', { name: 'Note #5, Open' }));

    await act(async () => reject(new Error('network down')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Note not saved. Annotations failed: network down The text is kept: pick the element again to retry.'
    );
    expect(screen.getByRole('dialog', { name: 'Note #5' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    pick();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Lost note');
  });

  it('a save that fails after the page changed says so', async () => {
    let reject: (e: unknown) => void = () => {};
    createAnnotation.mockReturnValue(new Promise((_, r) => (reject = r)));
    const { rerender } = render(<AnnotationUI />);
    await openSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Slow note');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    nav.path = '/faq';
    rerender(<AnnotationUI />);
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();

    await act(async () => reject(new Error('network down')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Note not saved. Annotations failed: network down The text is kept: go back to / and pick the element again to retry.'
    );
  });

  describe('a save that fails after the admin reopened the same element', () => {
    let reject: (e: unknown) => void = () => {};
    beforeEach(() => {
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
      createAnnotation.mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    });

    /** Save, move to the pin's note, then come back to the same element. */
    async function saveAndReopen() {
      render(<AnnotationUI />);
      await screen.findByRole('button', { name: 'Note #5, Open' });
      pick();
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Lost note');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await userEvent.click(screen.getByRole('button', { name: 'Note #5, Open' }));
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      pick();
    }

    it('tells the admin to close the open sheet to get the text back', async () => {
      await saveAndReopen();
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');

      await act(async () => reject(new Error('network down')));
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Note not saved. Annotations failed: network down The text is kept: close this note and pick the element again to get it back.'
      );
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
      pick();
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Lost note');
    });

    it('does not claim the text is kept when a newer draft took its place', async () => {
      await saveAndReopen();
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Newer');

      await act(async () => reject(new Error('network down')));
      expect(screen.getByRole('alert')).toHaveTextContent(/^Note not saved\. Annotations failed: network down$/);
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Newer');
    });

    it('keeps the error toast when a later save succeeds', async () => {
      createAnnotation.mockResolvedValueOnce({ number: 9, html_url: 'u9', status: 'open', created_at: '' });
      await saveAndReopen();
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Newer');
      await act(async () => reject(new Error('network down')));

      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull());
      expect(screen.getByRole('alert')).toHaveTextContent(/^Note not saved\./);
      expect(screen.queryByText('Saved as')).toBeNull();
    });
  });

  it('a failed save on a sheet still on screen shows the error there, not as a toast', async () => {
    createAnnotation.mockRejectedValue(new Error('network down'));
    render(<AnnotationUI />);
    await openSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Note');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Annotations failed: network down');
    expect(screen.queryByText(/Note not saved/)).toBeNull();
  });

  describe('opening a note from its pin', () => {
    const note = {
      number: 5, html_url: 'u', title: '', text: 'Answer too long', type: 'content', status: 'open',
      anchor: { path: '/', url: '', ann_id: 'answer-body', css_path: '' },
      created_at: '', updated_at: '', author: 'a',
    };
    beforeEach(() => {
      const answer = document.querySelector('[data-ann="answer-body"]')!;
      answer.getBoundingClientRect = () =>
        ({ left: 20, top: 100, right: 220, bottom: 140, width: 200, height: 40, x: 20, y: 100, toJSON() {} }) as DOMRect;
      listAnnotations.mockResolvedValue([note]);
    });

    it('does not carry a discard prompt into the note sheet', async () => {
      render(<AnnotationUI />);
      await openSheet();
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Draft');
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.getByText(/Discard note\?/)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Note #5, Open' }));
      expect(screen.getByRole('dialog', { name: 'Note #5' })).toBeInTheDocument();
      expect(screen.queryByText(/Discard note\?/)).toBeNull();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: 'Note #5' })).toBeNull();
    });

    it('turns pick mode off', async () => {
      render(<AnnotationUI />);
      await userEvent.click(await screen.findByRole('button', { name: /Annotations,/ }));
      await userEvent.click(screen.getByRole('menuitem', { name: /Annotate/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Note #5, Open' }));
      expect(screen.getByRole('dialog', { name: 'Note #5' })).toBeInTheDocument();
      expect(screen.queryByText('Tap anything')).toBeNull();

      // A plain click on the page is an ordinary click again, not a pick.
      const onClick = vi.fn();
      document.getElementById('p')!.addEventListener('click', onClick);
      await userEvent.click(document.getElementById('p')!);
      expect(onClick).toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
    });
  });

  it('Cancel and a successful save both clear the draft', async () => {
    render(<AnnotationUI />);
    await openSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Cancelled text');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    pick();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');

    createAnnotation.mockResolvedValue({ number: 8, html_url: 'u', status: 'open', created_at: '' });
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Saved text');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull());
    pick();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
  });

  it('still works when sessionStorage throws', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    try {
      render(<AnnotationUI />);
      await openSheet();
      await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Typed');
      expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Typed');
    } finally {
      setItem.mockRestore();
    }
  });

  it('closes the sheet, menu and pick mode when the page changes, and releases Escape', async () => {
    const { rerender } = render(<AnnotationUI />);
    await openSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Draft on home');
    nav.path = '/faq';
    rerender(<AnnotationUI />);
    expect(screen.queryByRole('dialog', { name: 'New note' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(app.onEscape).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /Annotations,/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Annotate/ }));
    expect(screen.getByText('Tap anything')).toBeInTheDocument();
    nav.path = '/terms';
    rerender(<AnnotationUI />);
    expect(screen.queryByText('Tap anything')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Annotations,/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    nav.path = '/faq';
    rerender(<AnnotationUI />);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(app.onEscape).toHaveBeenCalledTimes(2);

    // The home draft is still there when the admin comes back.
    nav.path = '/';
    rerender(<AnnotationUI />);
    pick();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Draft on home');
  });

  it('closes a note sheet whose note left the list and stops holding Escape', async () => {
    const answer = document.querySelector('[data-ann="answer-body"]')!;
    answer.getBoundingClientRect = () =>
      ({ left: 20, top: 100, right: 220, bottom: 140, width: 200, height: 40, x: 20, y: 100, toJSON() {} }) as DOMRect;
    const note = {
      number: 5, html_url: 'u', title: '', text: 'Answer too long', type: 'content', status: 'open',
      anchor: { path: '/', url: '', ann_id: 'answer-body', css_path: '' },
      created_at: '', updated_at: '', author: 'a',
    };
    listAnnotations.mockResolvedValue([note]);
    render(<AnnotationUI />);
    await userEvent.click(await screen.findByRole('button', { name: 'Note #5, Open' }));
    expect(screen.getByRole('dialog', { name: 'Note #5' })).toBeInTheDocument();

    // Marking it done succeeds, but the fresh reload no longer lists it.
    setAnnotationStatus.mockResolvedValue({ ...note, status: 'done' });
    listAnnotations.mockResolvedValue([]);
    await userEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Note #5' })).toBeNull());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(app.onEscape).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels tap-to-pick without reaching the app', async () => {
    render(<AnnotationUI />);
    await userEvent.click(await screen.findByRole('button', { name: /Annotations,/ }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Annotate/ }));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByText('Tap anything')).toBeNull();
    expect(app.onEscape).not.toHaveBeenCalled();
  });

  it('the menu closes on Escape and on a tap outside it', async () => {
    render(<AnnotationUI />);
    const fab = await screen.findByRole('button', { name: /Annotations,/ });
    await userEvent.click(fab);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(app.onEscape).not.toHaveBeenCalled();

    await userEvent.click(fab);
    fireEvent.pointerDown(document.getElementById('p')!);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('AnnotateLayer note loading', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    listAnnotations.mockReset();
  });

  it("ignores a slow response for a page the admin already left", async () => {
    const item = (number: number, path: string) => ({
      number, html_url: '', title: '', text: '', type: 'bug', status: 'open',
      anchor: { path, url: '', css_path: '' }, created_at: '', updated_at: '', author: 'a',
    });
    let resolveHome: (v: unknown) => void = () => {};
    let resolveFaq: (v: unknown) => void = () => {};
    listAnnotations.mockImplementation((path: string) =>
      new Promise((r) => {
        if (path === '/') resolveHome = r;
        else resolveFaq = r;
      })
    );
    nav.path = '/';
    const { rerender } = render(<AnnotationUI />);
    await waitFor(() => expect(listAnnotations).toHaveBeenCalledTimes(1));
    nav.path = '/faq';
    rerender(<AnnotationUI />);
    await waitFor(() => expect(listAnnotations).toHaveBeenCalledTimes(2));

    await act(async () => resolveFaq([item(9, '/faq')]));
    await act(async () => resolveHome([item(1, '/'), item(2, '/'), item(3, '/')]));
    expect(screen.getByRole('button', { name: 'Annotations, 1 open on this page' })).toBeInTheDocument();
  });
});

describe('AnnotateLayer keyboard', () => {
  const originalRect = Element.prototype.getBoundingClientRect;
  const vvListeners: Record<string, () => void> = {};
  let sheetTop = 500;

  const rect = (top: number, height: number) =>
    ({ left: 0, right: 390, width: 390, top, bottom: top + height, height, x: 0, y: top, toJSON() {} }) as DOMRect;

  beforeEach(() => {
    document.body.innerHTML = '';
    nav.path = '/';
    listAnnotations.mockReset();
    listAnnotations.mockResolvedValue([]);
    page();
    sheetTop = 500;
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.classList.contains('ann-sheet')) return rect(sheetTop, 844 - sheetTop);
      if (this.getAttribute('data-ann') === 'answer-body') return rect(300, 60);
      return originalRect.call(this);
    };
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 844,
        offsetTop: 0,
        addEventListener: (type: string, fn: () => void) => {
          vvListeners[type] = fn;
        },
        removeEventListener: () => {},
      },
    });
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect;
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true });
  });

  it('re-reveals the picked element once the keyboard pushes the sheet up', async () => {
    render(<AnnotationUI />);
    await openSheet();
    await new Promise((r) => setTimeout(r, 50));
    const scroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
    expect(scroll).not.toHaveBeenCalled();

    // A small move (sheet content growing) is not the keyboard.
    sheetTop = 480;
    act(() => vvListeners.resize());
    await new Promise((r) => setTimeout(r, 250));
    expect(scroll).not.toHaveBeenCalled();

    // Keyboard opens: the sheet rises past the picked element.
    sheetTop = 250;
    act(() => vvListeners.resize());
    expect(scroll).not.toHaveBeenCalled();
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  });
});

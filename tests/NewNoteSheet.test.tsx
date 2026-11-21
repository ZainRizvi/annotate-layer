import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { AnnotateError } from '../src/client';
import NewNoteSheet from '../src/NewNoteSheet';
import { annChain, buildAnchor } from '../src/picker';
import { fakeClient } from './helpers';

const client = fakeClient();
const createAnnotation = client.create;

function setupPage() {
  const page = document.createElement('div');
  page.innerHTML = `
    <div data-ann="message">
      <div data-ann="answer-body">
        <span data-ann="citation-chip"><button id="chip">User Guide, Section 864, p.117</button></span>
      </div>
    </div>`;
  document.body.appendChild(page);
  return annChain(page.querySelector('#chip')!);
}

const DRAFT_KEY = 'ann:draft:/c/abc|citation-chip|0';

function renderSheet(props: Partial<React.ComponentProps<typeof NewNoteSheet>> = {}) {
  const chain = setupPage();
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const { unmount } = render(
    <NewNoteSheet
      client={client}
      chain={chain}
      selected={0}
      onSelect={onSelect}
      path="/c/abc"
      input="touch"
      host={() => ({ theme: 'dark', lang: 'ar', env: 'development' })}
      onSaved={onSaved}
      onClose={onClose}
      draftKey={DRAFT_KEY}
      draftSnippet="User Guide, Section 864, p.117"
      snapshot={{
        viewport: { w: 390, h: 844, dpr: 3 },
        scroll: { x: 0, y: 1200.4 },
        rects: [
          { x: 24.25, y: 300, w: 120, h: 32 },
          { x: 16, y: 280, w: 358, h: 400.06 },
          { x: 0, y: 260, w: 390, h: 460 },
        ],
        anchors: chain.map((el) => buildAnchor(el, '/c/abc', window.location.href)),
      }}
      {...props}
    />
  );
  return { chain, onSaved, onClose, onSelect, unmount };
}

describe('NewNoteSheet', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
    createAnnotation.mockReset();
  });

  it('shows the data-ann chain as chips and selects one on tap', async () => {
    const { onSelect } = renderSheet();
    const group = screen.getByLabelText('Annotated element');
    const chips = Array.from(group.querySelectorAll('button'));
    expect(chips.map((c) => c.textContent)).toEqual(['citation-chip', 'answer-body', 'message']);
    expect(chips[0]).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(chips[1]);
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('switches the note type with the type chips', async () => {
    renderSheet();
    expect(screen.getByRole('radio', { name: 'Bug' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(screen.getByRole('radio', { name: 'Design' }));
    expect(screen.getByRole('radio', { name: 'Design' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Bug' })).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps Save disabled until there is text', async () => {
    renderSheet();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), '   ');
    expect(save).toBeDisabled();
  });

  it('saves the note with the selected element as anchor and the page context', async () => {
    createAnnotation.mockResolvedValue({ number: 42, html_url: 'https://github.com/x/42', status: 'open', created_at: '' });
    const { onSaved } = renderSheet({ selected: 1 });
    await userEvent.click(screen.getByRole('radio', { name: 'Content' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), '  Wrong section cited  ');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ number: 42 }), DRAFT_KEY, '/c/abc'));
    const body = createAnnotation.mock.calls[0][0];
    expect(body.text).toBe('Wrong section cited');
    expect(body.type).toBe('content');
    expect(body.anchor).toMatchObject({
      path: '/c/abc',
      url: window.location.href,
      ann_id: 'answer-body',
      text_snippet: 'User Guide, Section 864, p.117',
    });
    expect(document.querySelector(body.anchor.css_path)).toBe(document.querySelector('[data-ann="answer-body"]'));
    expect(body.anchor.ancestor_snippets).toEqual(['User Guide, Section 864, p.117']);
    // Rect, viewport and scroll come from the pick, not from the screen at save.
    expect(body.anchor.rect).toEqual({ x: 16, y: 280, w: 358, h: 400.1 });
    expect(body.anchor).not.toHaveProperty('drawing');
    expect(body.context).toMatchObject({
      viewport: { w: 390, h: 844, dpr: 3 },
      scroll: { x: 0, y: 1200 },
      input: 'touch',
      theme: 'dark',
      lang: 'ar',
      env: 'development',
      ua: navigator.userAgent,
    });
    expect(body).not.toHaveProperty('author');
  });

  it('saves the drawing with the anchor and says when strokes were left out', async () => {
    createAnnotation.mockResolvedValue({ number: 43, html_url: 'u', status: 'open', created_at: '' });
    const drawing = { strokes: [[[0, 0], [0.5, 1]]] as Array<Array<[number, number]>>, bbox: { x: 0, y: 0, w: 0.5, h: 1 } };
    renderSheet({ drawing, droppedStrokes: 2 });
    expect(screen.getByRole('status')).toHaveTextContent('2 strokes were left out');
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Circled');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createAnnotation).toHaveBeenCalled());
    expect(createAnnotation.mock.calls[0][0].anchor.drawing).toEqual(drawing);
  });

  it('saves the element as it was picked, not as it is when Save is pressed', async () => {
    createAnnotation.mockResolvedValue({ number: 44, html_url: 'u', status: 'open', created_at: '' });
    renderSheet();
    // The answer keeps streaming and the DOM shifts while the admin types.
    const chip = document.querySelector('#chip')!;
    chip.textContent = 'User Guide, Section 870, p.118 (updated)';
    chip.closest('[data-ann="message"]')!.before(document.createElement('div'));
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Wrong page');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createAnnotation).toHaveBeenCalled());
    const { anchor } = createAnnotation.mock.calls[0][0];
    expect(anchor.text_snippet).toBe('User Guide, Section 864, p.117');
    expect(anchor.css_path).toBe('body > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > span:nth-of-type(1)');
  });

  it('explains a 503 (annotations not configured) and keeps the text', async () => {
    createAnnotation.mockRejectedValue(new AnnotateError('not_configured', 'annotations_not_configured', 503));
    const { onSaved } = renderSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Chip overlaps');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not set up/i);
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Chip overlaps');
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('explains a 502 (the notes store failed) so the admin can retry', async () => {
    createAnnotation.mockRejectedValueOnce(new AnnotateError('http', 'Bad credentials', 502));
    createAnnotation.mockResolvedValueOnce({ number: 7, html_url: 'u', status: 'open', created_at: '' });
    const { onSaved } = renderSheet();
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Retry me');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The notes store returned an error: Bad credentials');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(createAnnotation).toHaveBeenCalledTimes(2);
  });

  it('takes the draft out of storage while saving, locks the sheet, and puts the draft back on failure', async () => {
    let reject: (e: unknown) => void = () => {};
    createAnnotation.mockReturnValue(new Promise((_, r) => (reject = r)));
    const onSavingChange = vi.fn();
    renderSheet({ onSavingChange });
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Chip overlaps');
    expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!).text).toBe('Chip overlaps');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull();
    expect(onSavingChange).toHaveBeenLastCalledWith(true, DRAFT_KEY);
    expect(screen.getByRole('button', { name: 'citation-chip' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveAttribute('readonly');

    await act(async () => reject(new AnnotateError('http', 'Bad gateway', 502)));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!)).toMatchObject({ text: 'Chip overlaps', type: 'bug' });
    expect(onSavingChange).toHaveBeenLastCalledWith(false, DRAFT_KEY);
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  });

  it('reports a failure only through onSaveFailedAway once the sheet is gone', async () => {
    let reject: (e: unknown) => void = () => {};
    createAnnotation.mockReturnValue(new Promise((_, r) => (reject = r)));
    const onSaveFailedAway = vi.fn();
    const { unmount } = renderSheet({ onSaveFailedAway });
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Chip overlaps');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    unmount();

    await act(async () => reject(new AnnotateError('http', 'Bad gateway', 502)));
    expect(onSaveFailedAway).toHaveBeenCalledWith(
      'The notes store returned an error: Bad gateway. Try again.',
      true,
      DRAFT_KEY,
      '/c/abc'
    );
    expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!)).toMatchObject({ text: 'Chip overlaps' });
  });

  it('does not call onSaveFailedAway while the sheet can show the error itself', async () => {
    createAnnotation.mockRejectedValue(new AnnotateError('http', 'Bad gateway', 502));
    const onSaveFailedAway = vi.fn();
    renderSheet({ onSaveFailedAway });
    await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), 'Chip overlaps');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onSaveFailedAway).not.toHaveBeenCalled();
  });

  it('restores a stored draft only onto an element with the same text', () => {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ text: 'Old draft', type: 'design', snippet: 'API Reference, Section 99, p.80' })
    );
    renderSheet();
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('');
    // The other element's draft is left alone.
    expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!).text).toBe('Old draft');
  });

  it('closes on Cancel', async () => {
    const { onClose } = renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

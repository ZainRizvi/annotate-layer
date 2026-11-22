import { beforeEach, describe, expect, it } from 'vitest';
import { draftKey, loadDraft, saveDraft } from '../src/draftStore';

describe('stored drafts', () => {
  let el: HTMLElement;
  beforeEach(() => {
    sessionStorage.clear();
    document.body.innerHTML = '<button data-ann="cta" data-ann-unique>Buy</button>';
    el = document.querySelector('button')!;
  });

  const anchor = { css_path: 'button', path: '/p', url: 'https://example.com/p', ann_id: 'cta' };

  it('restores a draft with a known type', () => {
    const key = draftKey('/p', el);
    saveDraft(key, { text: 'hi', type: 'design', snippet: 'Buy', anchor });
    expect(loadDraft(key, 'Buy', el)?.type).toBe('design');
  });

  it('keeps the text of a draft whose type the layer does not offer, as a bug', () => {
    const key = draftKey('/p', el);
    sessionStorage.setItem(key, JSON.stringify({ text: 'hi', type: 'rant', snippet: 'Buy', anchor }));
    expect(loadDraft(key, 'Buy', el)).toMatchObject({ text: 'hi', type: 'bug' });
  });
});

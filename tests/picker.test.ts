import { describe, it, expect, beforeEach } from 'vitest';
import {
  annChain,
  buildAnchor,
  cssPath,
  elementLabel,
  findAnchor,
  isEditable,
  resolvePickTarget,
  SNIPPET_SCAN_LIMIT,
  textSnippet,
} from '../src/picker';

function mount(html: string) {
  document.body.innerHTML = html;
}

const $ = (sel: string) => document.querySelector(sel)!;

describe('annotation picker', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('picks the nearest data-ann ancestor of the touched element', () => {
    mount(`
      <div data-ann="message">
        <div data-ann="answer-body"><p><strong id="t">Restart</strong> it twice</p></div>
      </div>`);
    expect(resolvePickTarget($('#t'))).toBe($('[data-ann="answer-body"]'));
  });

  it('falls back to the element itself when no ancestor is anchored', () => {
    mount(`<main><p id="t">Plain text</p></main>`);
    expect(resolvePickTarget($('#t'))).toBe($('#t'));
  });

  it('lists the data-ann chain innermost first', () => {
    mount(`
      <div data-ann="message">
        <div data-ann="answer-body">
          <span data-ann="citation-chip"><button id="t">User Guide, p.12</button></span>
        </div>
      </div>`);
    expect(annChain($('#t')).map(elementLabel)).toEqual(['citation-chip', 'answer-body', 'message']);
  });

  it('is just the element when nothing around it is anchored', () => {
    mount(`<main><section><p id="t">x</p></section></main>`);
    expect(annChain($('#t')).map(elementLabel)).toEqual(['p']);
  });

  it('builds a body-rooted nth-of-type CSS path that selects the same element', () => {
    mount(`<main><div></div><div><span>a</span><span id="t">b</span></div></main>`);
    const path = cssPath($('#t'));
    expect(path).toBe('body > main:nth-of-type(1) > div:nth-of-type(2) > span:nth-of-type(2)');
    expect(document.querySelector(path)).toBe($('#t'));
  });

  it('caps the CSS path at 8 levels', () => {
    mount('<div>'.repeat(12) + '<b id="t">deep</b>' + '</div>'.repeat(12));
    const path = cssPath($('#t'));
    expect(path.split(' > ')).toHaveLength(8);
    expect(path.startsWith('body')).toBe(false);
    expect(document.querySelector(path)).toBe($('#t'));
  });

  it('collapses whitespace and limits the snippet to 200 characters', () => {
    mount(`<p id="t">  first\n\n   second ${'x'.repeat(400)}</p>`);
    const snippet = textSnippet($('#t'));
    expect(snippet.startsWith('first second x')).toBe(true);
    expect(snippet).toHaveLength(200);
  });

  it('treats inputs, textareas, selects and contenteditable as editable', () => {
    mount(`
      <input id="i"><textarea id="ta"></textarea><select id="s"></select>
      <div contenteditable="true"><span id="ce">x</span></div>
      <div contenteditable="false"><span id="off">x</span></div>
      <p id="p">text</p>`);
    expect(['#i', '#ta', '#s', '#ce'].map((s) => isEditable($(s)))).toEqual([true, true, true, true]);
    expect(isEditable($('#off'))).toBe(false);
    expect(isEditable($('#p'))).toBe(false);
  });

  describe('findAnchor', () => {
    it('uses the snippet to tell repeated data-ann elements apart', () => {
      mount(`
        <span data-ann="citation-chip">User Guide, Section 12, p.4</span>
        <span data-ann="citation-chip" id="want">API Reference, Section 99, p.80</span>`);
      const anchor = buildAnchor($('#want'), '/c/1', 'http://x/c/1');
      expect(findAnchor(anchor)).toBe($('#want'));
    });

    it('does not take a sole data-ann element whose text no longer holds the snippet', () => {
      // A note on section B's quote while section A's modal is open.
      mount(`<div data-ann="doc-quote" id="a">Section 12: restart the server after upgrading.</div>`);
      const anchor = {
        path: '/', url: 'u', ann_id: 'doc-quote', css_path: 'body > div:nth-of-type(1)',
        text_snippet: 'Section 99: tokens expire after one hour.',
      };
      expect(findAnchor(anchor)).toBeNull();

      // The same quote elsewhere on the page (untagged) is still found by its text.
      mount(`
        <div data-ann="doc-quote">Section 12: restart the server after upgrading.</div>
        <blockquote id="b">Section 99: tokens expire after one hour.</blockquote>`);
      expect(findAnchor(anchor)).toBe($('#b'));
    });

    it('still takes a sole data-ann element with the snippet, or when no snippet was stored', () => {
      mount(`<div data-ann="doc-quote" id="a">Section 99: tokens expire after one hour.</div>`);
      const anchor = { path: '/', url: 'u', ann_id: 'doc-quote', css_path: '', text_snippet: 'Section 99: tokens expire' };
      expect(findAnchor(anchor)).toBe($('#a'));
      expect(findAnchor({ ...anchor, text_snippet: undefined })).toBe($('#a'));
    });

    it('does not guess when the 8-level CSS path selects several repeats', () => {
      // Two answers whose rows differ only above the 8 levels the path keeps.
      const deep = (id: string) =>
        `<div><div><div><div><div><div><div><div><nav data-ann="feedback-buttons"${id}>Helpful?</nav></div></div></div></div></div></div></div></div>`;
      mount(`<section>${deep('')}</section><article>${deep(' id="want"')}</article>`);
      const anchor = buildAnchor($('#want'), '/c/1', 'http://x/c/1');
      expect(anchor.css_path.startsWith('body')).toBe(false);
      expect(document.querySelectorAll(anchor.css_path)).toHaveLength(2);
      expect(findAnchor(anchor)).toBeNull();
    });

    it('takes the CSS-path fallback only when the path selects exactly one element with the snippet', () => {
      const deep = (id: string, text: string) =>
        `<div><div><div><div><div><div><div><div><p${id}>${text}</p></div></div></div></div></div></div></div></div>`;
      mount(`<section>${deep('', 'Resetting a password')}</section><article>${deep(' id="want"', 'Resetting a password')}</article>`);
      const anchor = { ...buildAnchor($('#want'), '/c/1', 'http://x/c/1'), text_snippet: 'Resetting' };
      expect(findAnchor(anchor, document, { snippetSearch: false })).toBeNull();

      // Only one of the path's elements still has the text: that one.
      mount(`<section>${deep('', 'Invoices by month')}</section><article>${deep(' id="want"', 'Resetting a password')}</article>`);
      expect(findAnchor(anchor, document, { snippetSearch: false })).toBe($('#want'));
    });

    it('does not let a tagged copy of the text win over an equal untagged original', () => {
      // An untagged note whose CSS path is stale: its text is in the original
      // paragraph and, quoted, in a tagged element.
      mount(`<main><p id="orig">Restart it before upgrading the server</p><div data-ann="doc-quote"><p>Restart it before upgrading the server</p></div></main>`);
      const anchor = { path: '/', url: 'u', css_path: 'body > aside', text_snippet: 'Restart it before upgrading the server' };
      expect(findAnchor(anchor)).toBeNull();

      // Without the copy, the original is found.
      mount(`<main><p id="orig">Restart it before upgrading the server</p></main>`);
      expect(findAnchor(anchor)).toBe($('#orig'));
    });

    it('does not guess when the snippet search finds several unrelated equal matches', () => {
      mount(`<main><p>Restart it before upgrading the server</p><p>Restart it before upgrading the server</p></main>`);
      const anchor = { path: '/', url: 'u', css_path: 'body > aside', text_snippet: 'Restart it before upgrading the server' };
      expect(findAnchor(anchor)).toBeNull();

      // Nested elements with the same text are one match: the deepest.
      mount(`<main><div><p id="t">Restart it before upgrading the server</p></div></main>`);
      expect(findAnchor(anchor)).toBe($('#t'));

      // A shorter (closer) match still beats a longer one elsewhere.
      mount(`<main><p id="t">Restart it before upgrading the server</p><p>Restart it before upgrading the server, then dry it</p></main>`);
      expect(findAnchor(anchor)).toBe($('#t'));
    });

    describe('repeats told apart by the text around them', () => {
      const answer = (n: number) =>
        `<div data-ann="message" id="m${n}"><p>Answer ${n}: billing rules for teams</p>` +
        `<div data-ann="feedback-buttons" id="fb${n}">Helpful?</div></div>`;
      const chat = () => document.querySelector('main')!;

      it('records the ancestors, innermost first, skipping data-ann-unique ones', () => {
        mount(`<main>${answer(1)}${answer(2)}</main>`);
        const anchor = buildAnchor($('#fb2'), '/c/1', 'u');
        expect(anchor.ancestor_snippets).toEqual([textSnippet($('#m2'))]);

        mount(`<nav data-ann="sidebar" data-ann-unique><a data-ann="conversation-item" id="c">Invoices</a></nav>`);
        expect(buildAnchor($('#c'), '/', 'u')).not.toHaveProperty('ancestor_snippets');
      });

      it('keeps a note on answer 2 row when answer 1 goes away or older answers load above', () => {
        mount(`<main>${answer(1)}${answer(2)}${answer(3)}</main>`);
        const anchor = buildAnchor($('#fb2'), '/c/1', 'u');

        $('#m1').remove();
        expect(findAnchor(anchor)).toBe($('#fb2'));

        chat().insertAdjacentHTML('afterbegin', answer(0) + answer(-1));
        expect(findAnchor(anchor)).toBe($('#fb2'));
      });

      it('shows the note as moved once answer 2 is gone, even with a single row left', () => {
        mount(`<main>${answer(1)}${answer(2)}${answer(3)}</main>`);
        const anchor = buildAnchor($('#fb2'), '/c/1', 'u');
        $('#m2').remove();
        expect(findAnchor(anchor)).toBeNull();
        $('#m1').remove();
        expect(findAnchor(anchor)).toBeNull();
      });

      it('treats a stored ancestor that no longer exists as a mismatch', () => {
        // The note's message is gone; a same-named row with the same text sits
        // outside any tagged message.
        mount(`<main>${answer(2)}</main>`);
        const anchor = buildAnchor($('#fb2'), '/c/1', 'u');
        mount(`<main><div data-ann="feedback-buttons" id="loose">Helpful?</div></main>`);
        expect(findAnchor(anchor)).toBeNull();
      });

      it('leaves notes saved without ancestor text to the CSS-path tie-break, as before', () => {
        mount(`<main>${answer(1)}${answer(2)}${answer(3)}</main>`);
        const { ancestor_snippets: _dropped, ...legacy } = buildAnchor($('#fb2'), '/c/1', 'u');
        void _dropped;
        expect(findAnchor({ ...legacy, ancestor_snippets: null })).toBe($('#fb2'));
      });
    });

    describe('answers that share a long introduction', () => {
      const intro = 'Thanks for your question. Here is a summary of the relevant documentation: ';
      const body = (n: number, rest: string) =>
        `<div data-ann="answer-body" id="a${n}"><p>${intro}${rest}</p></div>`;

      it('tells repeats apart by the whole stored snippet, not its first 60 characters', () => {
        mount(`<main>${body(1, 'password reset links expire after an hour.')}${body(2, 'invoices are sent on the first of each month.')}</main>`);
        const anchor = buildAnchor($('#a2'), '/c/1', 'u');
        // Reordered: answer 2 now sits where answer 1 was, so the CSS path points at answer 1.
        const main = document.querySelector('main')!;
        main.prepend($('#a2'));
        expect(findAnchor(anchor)).toBe($('#a2'));
      });

      it('compares ancestor text in full too', () => {
        const message = (n: number, rest: string) =>
          `<div data-ann="message" id="m${n}"><p>${intro}${rest}</p><div data-ann="feedback-buttons" id="fb${n}">Helpful?</div></div>`;
        mount(`<main>${message(1, 'password reset links expire after an hour.')}${message(2, 'invoices are sent on the first of each month.')}</main>`);
        const anchor = buildAnchor($('#fb2'), '/c/1', 'u');
        document.querySelector('main')!.prepend($('#m2'));
        expect(findAnchor(anchor)).toBe($('#fb2'));
      });

      it('still matches an answer that kept streaming, and not one edited within the snippet', () => {
        mount(`<main>${body(1, 'password reset links expire after an hour.')}${body(2, 'invoices are sent')}</main>`);
        const anchor = buildAnchor($('#a2'), '/c/1', 'u');
        $('#a2 p').textContent += ' on the first of each month, and on renewal too.';
        expect(findAnchor(anchor)).toBe($('#a2'));
        $('#a2 p').textContent = intro + 'refunds are processed weekly.';
        expect(findAnchor(anchor)).toBeNull();
      });

      it('keeps a sole element matched by its leading text, as before', () => {
        mount(`<main>${body(2, 'invoices are sent on the first of each month.')}</main>`);
        const anchor = buildAnchor($('#a2'), '/c/1', 'u');
        $('#a2 p').textContent = intro + 'invoices (edited) are sent monthly.';
        expect(findAnchor(anchor)).toBe($('#a2'));
      });
    });

    it('takes a sole data-ann-unique element whatever its text now', () => {
      mount(`<nav data-ann="sidebar" data-ann-unique id="s">Acme Docs New chat Today: Resetting a password</nav>`);
      const anchor = {
        path: '/', url: 'u', ann_id: 'sidebar', css_path: '',
        text_snippet: 'Acme Docs New chat Today: Exporting invoices',
      };
      expect(findAnchor(anchor)).toBe($('#s'));
    });

    it('uses the CSS path to tell apart repeats with the same name and text', () => {
      mount(`
        <section><div data-ann="feedback-buttons">Helpful?</div></section>
        <section><div data-ann="feedback-buttons">Helpful?</div></section>
        <section><div data-ann="feedback-buttons" id="want">Helpful?</div></section>`);
      const anchor = buildAnchor($('#want'), '/c/1', 'http://x/c/1');
      expect(findAnchor(anchor)).toBe($('#want'));

      // The layout changed: the stored path now selects none of the repeats.
      // Picking one would be a guess, possibly another answer's row.
      mount(`
        <div><div data-ann="feedback-buttons">Helpful?</div></div>
        <div><div data-ann="feedback-buttons">Helpful?</div></div>`);
      expect(findAnchor(anchor)).toBeNull();
    });

    it('falls back to the CSS path when the data-ann name is gone', () => {
      mount(`<main><p>one</p><p id="t">two words here</p></main>`);
      const anchor = { path: '/', url: 'u', ann_id: 'renamed', css_path: cssPath($('#t')), text_snippet: 'two words here' };
      expect(findAnchor(anchor)).toBe($('#t'));
    });

    it('falls back to a snippet search when the layout changed', () => {
      mount(`<main><section><p id="t">Restart it before upgrading the server</p></section></main>`);
      const anchor = {
        path: '/',
        url: 'u',
        css_path: 'body > div:nth-of-type(3)',
        text_snippet: 'Restart it before upgrading the server',
      };
      expect(findAnchor(anchor)).toBe($('#t'));
    });

    it('matches a rendered-text snippet against text whose blocks have no spaces between them', () => {
      mount(`<main><section id="t"><h1>Product Docs</h1><p>Answered for every reader</p></section></main>`);
      const el = $('#t');
      // Browsers render block boundaries as line breaks in innerText; jsdom has no innerText.
      Object.defineProperty(el, 'innerText', { value: 'PRODUCT DOCS\nAnswered for every reader' });
      const anchor = buildAnchor(el, '/', 'u');
      expect(anchor.text_snippet).toBe('PRODUCT DOCS Answered for every reader');
      expect(findAnchor({ ...anchor, css_path: 'body > nav:nth-of-type(1)' })).toBe(el);
    });

    it('searches anchored subtrees in full but only a bounded part of the rest of the page', () => {
      const filler = '<i>filler</i>'.repeat(2000);
      mount(`<main>${filler}<section data-ann="answer-body"><p id="anchored">Restart it before upgrading the server</p></section></main>`);
      const anchor = { path: '/', url: 'u', css_path: '', text_snippet: 'Restart it before upgrading the server' };
      expect(findAnchor(anchor)).toBe($('#anchored'));

      mount(`<main>${filler}</main><footer><p id="far">Restart it before upgrading the server</p></footer>`);
      expect(findAnchor(anchor)).toBeNull();
    });

    it('marks a note moved, without a snippet search, when its name repeats and no element has its text', () => {
      mount(`
        <section data-ann="citation-chip">User Guide, p.4</section>
        <section data-ann="citation-chip">API Reference, p.80</section>
        <p id="elsewhere">Restart it before upgrading the server</p>`);
      const anchor = {
        path: '/', url: 'u', ann_id: 'citation-chip', css_path: '',
        text_snippet: 'Restart it before upgrading the server',
      };
      expect(findAnchor(anchor)).toBeNull();
      // An untagged note with the same snippet still gets the search.
      expect(findAnchor({ ...anchor, ann_id: undefined })).toBe($('#elsewhere'));
    });

    it('shares one scan budget between the anchored pass and the rest of the page', () => {
      const anchoredFiller = '<i data-ann="row">row</i>'.repeat(SNIPPET_SCAN_LIMIT);
      mount(`<p id="t">Restart it before upgrading the server</p><main>${anchoredFiller}</main>`);
      const anchor = { path: '/', url: 'u', css_path: '', text_snippet: 'Restart it before upgrading the server' };
      expect(findAnchor(anchor)).toBeNull();
      mount(`<p id="t">Restart it before upgrading the server</p><main>${'<i data-ann="row">row</i>'.repeat(10)}</main>`);
      expect(findAnchor(anchor)).toBe($('#t'));
    });

    it('skips the snippet search when asked to', () => {
      mount(`<main><p id="t">Restart it before upgrading the server</p></main>`);
      const anchor = { path: '/', url: 'u', css_path: '', text_snippet: 'Restart it before upgrading the server' };
      expect(findAnchor(anchor, document, { snippetSearch: false })).toBeNull();
      expect(findAnchor(anchor)).toBe($('#t'));
    });

    it('returns null when the element is no longer on the page', () => {
      mount(`<main><p>Something else entirely</p></main>`);
      const anchor = {
        path: '/',
        url: 'u',
        ann_id: 'doc-quote',
        css_path: 'body > aside:nth-of-type(1)',
        text_snippet: 'Restart it before upgrading the server',
      };
      expect(findAnchor(anchor)).toBeNull();
    });

    it('never anchors to the layer UI itself', () => {
      mount(`<div data-ann-ui><p>Restart it before upgrading the server</p></div>`);
      const anchor = { path: '/', url: 'u', css_path: '', text_snippet: 'Restart it before upgrading the server' };
      expect(findAnchor(anchor)).toBeNull();
    });
  });
});

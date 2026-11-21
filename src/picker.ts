import type { AnnotationAnchor } from './types';

/** Attribute that marks the layer's own UI; the picker and long-press skip it. */
export const LAYER_UI_ATTR = 'data-ann-ui';
/**
 * On a `[data-ann]` element: its name alone identifies it (one per page, such
 * as the sidebar or the composer), so a note on it stays pinned when its text
 * changes.
 */
export const UNIQUE_ATTR = 'data-ann-unique';

export const SNIPPET_MAX = 200;
const CSS_PATH_MAX_DEPTH = 8;
/**
 * Leading snippet characters compared for a sole `data-ann` match, which
 * needs no telling apart. Choosing among several candidates compares the
 * whole stored snippet: answers often share a long introduction.
 */
const SNIPPET_KEY_LENGTH = 60;
/** Snippet search is skipped below this length: too many false matches. */
const SNIPPET_SEARCH_MIN = 12;
/** Elements the snippet search reads at most, across both of its passes. */
export const SNIPPET_SCAN_LIMIT = 1500;

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

export function isInLayerUI(el: Element | null): boolean {
  return !!el?.closest(`[${LAYER_UI_ATTR}]`);
}

/**
 * The topmost page element at viewport point (x, y), looking through the
 * layer's own UI (pins, outlines, marks) so it never hides what is beneath.
 * `null` when only layer UI or nothing is there; `undefined` when the browser
 * cannot tell (no `elementsFromPoint`).
 */
export function pageElementAt(x: number, y: number): Element | null | undefined {
  if (typeof document.elementsFromPoint !== 'function') return undefined;
  return document.elementsFromPoint(x, y).find((el) => !isInLayerUI(el)) ?? null;
}

/** Inputs and editable regions where long-press must keep its native behaviour. */
export function isEditable(el: Element | null): boolean {
  return !!el?.closest(EDITABLE_SELECTOR);
}

/** The element a pick lands on: nearest `[data-ann]` ancestor, else the element itself. */
export function resolvePickTarget(el: Element): Element {
  return el.closest('[data-ann]') ?? el;
}

/**
 * The picked element followed by each `[data-ann]` ancestor, innermost first.
 * The sheet shows these as chips so a finger pick can be widened.
 */
export function annChain(el: Element): Element[] {
  const target = resolvePickTarget(el);
  const chain: Element[] = [target];
  let node = target.parentElement?.closest('[data-ann]') ?? null;
  while (node) {
    chain.push(node);
    node = node.parentElement?.closest('[data-ann]') ?? null;
  }
  return chain;
}

/** Short label for a chip: the `data-ann` name, else the tag name. */
export function elementLabel(el: Element): string {
  return el.getAttribute('data-ann') ?? el.tagName.toLowerCase();
}

/**
 * `tag:nth-of-type(n)` segments joined by ` > `, at most 8 levels. A path that
 * reaches `<body>` is rooted at it; a deeper element gets a relative path.
 */
export function cssPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  const isRoot = (n: Element | null) => !!n && (n.tagName === 'BODY' || n.tagName === 'HTML');
  while (node && !isRoot(node) && parts.length < CSS_PATH_MAX_DEPTH) {
    const tag = node.tagName.toLowerCase();
    let index = 1;
    let sibling = node.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === node.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${tag}:nth-of-type(${index})`);
    node = node.parentElement;
  }
  return (isRoot(node) ? ['body', ...parts] : parts).join(' > ');
}

/**
 * Rendered text where the browser provides it (block boundaries become
 * spaces), else `textContent`. Collapsed to single spaces.
 */
function readableText(el: Element): string {
  const inner = (el as HTMLElement).innerText;
  const raw = typeof inner === 'string' ? inner : el.textContent ?? '';
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Comparison form: no whitespace, lower case. `innerText` and `textContent`
 * differ in spacing and CSS text-transform, so matching ignores both.
 */
function matchKey(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/** Visible text of the element, whitespace-collapsed, at most 200 characters. */
export function textSnippet(el: Element): string {
  return readableText(el).slice(0, SNIPPET_MAX);
}

/**
 * How much of a stored snippet must still be in the element's text.
 * `full`: all of it (up to 200 characters), for choosing among candidates.
 * `lead`: the first 60 characters, for a sole match.
 */
type SnippetMatch = 'full' | 'lead';

/**
 * Whether two snippets of one element can come from the same text at two
 * moments: once normalized, one starts with the other (an answer that kept
 * streaming, or one re-rendered shorter).
 */
export function snippetsCompatible(a: string, b: string): boolean {
  const x = matchKey(a);
  const y = matchKey(b);
  return x.startsWith(y) || y.startsWith(x);
}

function snippetKey(snippet: string, match: SnippetMatch = 'full'): string {
  const key = matchKey(snippet);
  return match === 'lead' ? key.slice(0, SNIPPET_KEY_LENGTH) : key;
}

/**
 * Whether the element's text still holds the snippet. The snippet is the
 * element's first 200 characters when it was picked, so text that grew since
 * (a streaming answer) still holds it, and text edited within those
 * characters does not. `includes` rather than `startsWith` because the
 * snippet comes from rendered text and `textContent` also has hidden text.
 */
function snippetMatches(el: Element, snippet: string | undefined, match: SnippetMatch = 'full'): boolean {
  if (!snippet) return true;
  return matchKey(el.textContent ?? '').includes(snippetKey(snippet, match));
}

export const ANCESTOR_SNIPPETS_MAX = 6;

/**
 * The element's `[data-ann]` ancestors that have text, innermost first, at
 * most ANCESTOR_SNIPPETS_MAX: the ancestors `ancestor_snippets` describes.
 * `data-ann-unique` ancestors are left out: they are identified by name and
 * their text changes (a sidebar listing new conversations above old ones).
 */
function textAncestors(el: Element): Element[] {
  const found: Element[] = [];
  let node = el.parentElement?.closest('[data-ann]') ?? null;
  while (node && found.length < ANCESTOR_SNIPPETS_MAX) {
    if (!node.hasAttribute(UNIQUE_ATTR) && textSnippet(node)) found.push(node);
    node = node.parentElement?.closest('[data-ann]') ?? null;
  }
  return found;
}

/**
 * Whether `el` sits in ancestors whose text matches `stored`, position by
 * position over the list `textAncestors` builds. Every stored snippet needs a
 * matching ancestor at its position: a missing one (the message around the
 * row was removed) is a mismatch. True when nothing was stored.
 */
function ancestorsMatch(
  el: Element,
  stored: string[] | null | undefined,
  match: SnippetMatch = 'full'
): boolean {
  if (!stored?.length) return true;
  const ancestors = textAncestors(el);
  return stored.every((snippet, i) => !!ancestors[i] && snippetMatches(ancestors[i], snippet, match));
}

/** Everything the backend stores to find this element again. */
export function buildAnchor(el: Element, path: string, url: string): AnnotationAnchor {
  const annId = el.getAttribute('data-ann') ?? undefined;
  const snippet = textSnippet(el);
  const ancestors = textAncestors(el).map(textSnippet);
  return {
    path,
    url,
    ...(annId ? { ann_id: annId } : {}),
    css_path: cssPath(el),
    ...(snippet ? { text_snippet: snippet } : {}),
    ...(ancestors.length ? { ancestor_snippets: ancestors } : {}),
  };
}

/** Every element `selector` selects (a CSS path stops at 8 levels, so it can select several). */
function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/** The one element of `elements` that `keep` accepts, or null for none or several. */
function only(elements: Element[], keep: (el: Element) => boolean): Element | null {
  const kept = elements.filter(keep);
  return kept.length === 1 ? kept[0] : null;
}

const AMBIGUOUS = Symbol('ambiguous');

/**
 * The element among `elements` whose text starts with `key` and is shortest.
 * The snippet is the leading text of the noted element, so a container that
 * merely includes it further down (a page wrapper) does not count. Of nested
 * elements with the same text, the deepest wins. Several unrelated elements
 * with the same best text are AMBIGUOUS: picking one would be a guess.
 */
function deepestMatch(elements: Iterable<Element>, key: string): Element | null | typeof AMBIGUOUS {
  let best: Element[] = [];
  let bestLength = Infinity;
  for (const el of elements) {
    if (isInLayerUI(el) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    const text = matchKey(el.textContent ?? '');
    if (!text.startsWith(key) || text.length > bestLength) continue;
    if (text.length < bestLength) {
      best = [el];
      bestLength = text.length;
    } else {
      best.push(el);
    }
  }
  const innermost = best.filter((el) => !best.some((other) => other !== el && el.contains(other)));
  if (innermost.length === 0) return null;
  return innermost.length === 1 ? innermost[0] : AMBIGUOUS;
}

/**
 * Reads anchored subtrees first, then the rest of the page, sharing one
 * budget of SNIPPET_SCAN_LIMIT elements so a long chat never costs a
 * full-DOM text read. The best match is chosen across everything read: a
 * tagged copy of the text does not beat an equal untagged original.
 */
function searchBySnippet(root: ParentNode, snippet: string, ancestors?: string[] | null): Element | null {
  const key = snippetKey(snippet);
  const scanned = Array.from(root.querySelectorAll('[data-ann], [data-ann] *')).slice(
    0,
    SNIPPET_SCAN_LIMIT
  );
  if (scanned.length < SNIPPET_SCAN_LIMIT) {
    const seen = new Set(scanned);
    for (const el of Array.from(root.querySelectorAll('body *'))) {
      if (scanned.length >= SNIPPET_SCAN_LIMIT) break;
      if (!seen.has(el)) scanned.push(el);
    }
  }
  const found = deepestMatch(
    scanned.filter((el) => ancestorsMatch(el, ancestors)),
    key
  );
  return found === AMBIGUOUS ? null : found;
}

/**
 * Find an anchored element on the current page. Order: `data-ann` (its text
 * must still contain the snippet, which also breaks ties between repeats) →
 * CSS path → snippet search. `null` means the element moved or no longer
 * exists.
 *
 * No step guesses: each takes an element only when exactly one candidate
 * qualifies (one repeat on the stored CSS path, one path match with the
 * snippet, one innermost snippet match). A tie it cannot break is `null`, so
 * the note shows as moved rather than on another element.
 *
 * A sole `data-ann` match whose text no longer holds the snippet is not taken
 * (a note on one section's quote must not pin onto another section's modal),
 * unless it carries `data-ann-unique`. An element whose leading text changes
 * therefore shows as moved rather than on the wrong element.
 *
 * A note whose `data-ann` name still has several elements on the page, none
 * with its text, gets no snippet search: anything that search found would be
 * a differently named element, a wrong anchor. It shows as moved instead.
 */
export function findAnchor(
  anchor: AnnotationAnchor,
  root: ParentNode = document,
  options: {
    snippetSearch?: boolean;
    /**
     * False: the positional CSS path decides nothing. Repeats the text cannot
     * tell apart give null, and an untagged element is found by its text only.
     */
    pathTieBreak?: boolean;
  } = {}
): Element | null {
  let sameNameUnmatched = false;
  if (anchor.ann_id) {
    let candidates: Element[] = [];
    try {
      candidates = Array.from(
        root.querySelectorAll(`[data-ann="${CSS.escape(anchor.ann_id)}"]`)
      ).filter((el) => !isInLayerUI(el));
    } catch {
      candidates = [];
    }
    if (candidates.length === 1) {
      const [only] = candidates;
      if (
        only.hasAttribute(UNIQUE_ATTR) ||
        (snippetMatches(only, anchor.text_snippet, 'lead') &&
          ancestorsMatch(only, anchor.ancestor_snippets, 'lead'))
      ) {
        return only;
      }
    } else if (candidates.length > 1) {
      // Own text first, then the text around it (the answer a feedback row
      // sits in), and only then the positional CSS path.
      const matching = candidates.filter(
        (el) => snippetMatches(el, anchor.text_snippet) && ancestorsMatch(el, anchor.ancestor_snippets)
      );
      if (matching.length === 1) return matching[0];
      if (matching.length > 1) {
        // Same name and same text (e.g. every answer's feedback row): the
        // stored CSS path tells the repeats apart. Unless it selects exactly
        // one of them, any pick would be a guess: the note shows as moved.
        if (options.pathTieBreak === false) return null;
        const byPath = anchor.css_path ? safeQueryAll(root, anchor.css_path) : [];
        return only(byPath, (el) => matching.includes(el));
      }
      sameNameUnmatched = true;
    }
  }

  if (anchor.css_path && options.pathTieBreak !== false) {
    const byPath = only(
      safeQueryAll(root, anchor.css_path),
      (el) =>
        !isInLayerUI(el) &&
        snippetMatches(el, anchor.text_snippet) &&
        ancestorsMatch(el, anchor.ancestor_snippets)
    );
    if (byPath) return byPath;
  }

  const { snippetSearch = true } = options;
  if (
    snippetSearch &&
    !sameNameUnmatched &&
    anchor.text_snippet &&
    anchor.text_snippet.length >= SNIPPET_SEARCH_MIN
  ) {
    return searchBySnippet(root, anchor.text_snippet, anchor.ancestor_snippets);
  }
  return null;
}

import { ANNOTATION_TYPES, type AnnotationAnchor, type AnnotationDrawing, type AnnotationType } from './types';
import { cssPath, findAnchor, isInLayerUI, snippetsCompatible, UNIQUE_ATTR } from './picker';
import { isDrawing } from './drawing';

/**
 * Unsaved note drafts, kept in sessionStorage so a sheet closed by accident
 * (Back, a tap elsewhere, a route change) gives the text, type and marks back
 * when the admin opens a note on the same element again. Storage failures are ignored: the
 * draft is a convenience, the sheet works without it.
 */

export interface NoteDraft {
  text: string;
  type: AnnotationType;
  /**
   * The element's text when the draft was written. Index keys shift when rows
   * reorder or older messages load, so a draft is only restored onto an
   * element whose text still matches.
   */
  snippet: string;
  /** Marks drawn for the note, relative to the element the draft belongs to. */
  drawing?: AnnotationDrawing;
  /**
   * The element's anchor when the sheet opened, as a saved note stores it.
   * Repeats with identical text (every card's action row) share an index
   * key once rows shift; the anchor's ancestor text tells them apart.
   */
  anchor?: AnnotationAnchor;
}

function isAnnotationType(value: unknown): value is AnnotationType {
  return ANNOTATION_TYPES.some((type) => type === value);
}

function isAnchor(value: unknown): value is AnnotationAnchor {
  if (!value || typeof value !== 'object') return false;
  const { css_path, path, ancestor_snippets } = value as Partial<AnnotationAnchor>;
  return (
    typeof css_path === 'string' &&
    typeof path === 'string' &&
    (ancestor_snippets == null ||
      (Array.isArray(ancestor_snippets) && ancestor_snippets.every((s) => typeof s === 'string')))
  );
}

/**
 * Whether a draft stored with `anchor` belongs to `el`. The stored `ann_id`
 * must be `el`'s `data-ann` name (both absent for an untagged element): two
 * elements can share a snippet, such as the composer and the icon-only
 * controls around its plan switcher. A `data-ann-unique` element is then
 * identified by that name. Any other element must be exactly what the stored
 * anchor resolves to; anything else (another row, nothing, a tie) is not
 * restored: the same never-guess rule as for notes. `grown`: the element's
 * text grew (or shrank) since the draft was written.
 */
function draftBelongsTo(anchor: unknown, el: Element, grown: boolean): boolean {
  if (!isAnchor(anchor) || (anchor.ann_id ?? null) !== el.getAttribute('data-ann')) return false;
  if (el.hasAttribute(UNIQUE_ATTR)) return true;
  // A draft started on half-streamed text stored only its first words,
  // which repeats may share (a common introduction). Then the text must tell
  // the repeats apart: their position alone could hand the draft to another
  // item after a reorder.
  return findAnchor(anchor, document, { pathTieBreak: !grown }) === el;
}

const PREFIX = 'ann:draft:';

/**
 * One draft per page and element instance. Names such as `product-card` and
 * `citation-chip` repeat once per message, so a tagged element is keyed by its
 * name plus its position among same-named elements; an untagged one by its
 * CSS path. Read once when the sheet opens: the DOM keeps changing after.
 */
export function draftKey(path: string, el: Element): string {
  const name = el.getAttribute('data-ann');
  if (name === null) return `${PREFIX}${path}|${cssPath(el)}`;
  const same = Array.from(document.querySelectorAll(`[data-ann="${CSS.escape(name)}"]`)).filter(
    (other) => !isInLayerUI(other)
  );
  return `${PREFIX}${path}|${name}|${Math.max(0, same.indexOf(el))}`;
}

/**
 * The draft stored as `raw`, if it parses and was written for `el`. The
 * snippet check is only a cheap precheck for compatible growth (a draft
 * started while its text was still streaming in); `draftBelongsTo` decides
 * identity.
 */
function draftFor(raw: string | null, snippet: string, el: Element): NoteDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<NoteDraft>;
    if (typeof parsed.text !== 'string' || typeof parsed.type !== 'string') return null;
    if (typeof parsed.snippet !== 'string' || !snippetsCompatible(parsed.snippet, snippet)) return null;
    if (!draftBelongsTo(parsed.anchor, el, parsed.snippet !== snippet)) return null;
    // A drawing that does not validate is dropped; the text still comes back.
    const drawing = isDrawing(parsed.drawing) && parsed.drawing.strokes.length > 0 ? parsed.drawing : undefined;
    return {
      text: parsed.text,
      // A stored type the layer no longer offers falls back to the sheet's default; the text still comes back.
      type: isAnnotationType(parsed.type) ? parsed.type : 'bug',
      snippet,
      ...(drawing ? { drawing } : {}),
      ...(isAnchor(parsed.anchor) ? { anchor: parsed.anchor } : {}),
    };
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** This page's draft keys other than `except`. */
function pageDraftKeys(path: string, except: string): string[] {
  const prefix = `${PREFIX}${path}|`;
  const keys: string[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key !== except && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    // No storage: no drafts.
  }
  return keys;
}

/**
 * The storage key for a sheet opening on `el`, and the draft to restore.
 * The stored anchor is the draft's identity; the key (name plus index) is
 * only where it is usually found. When `el` moved (an older item loaded
 * above it), its draft is found under another of this page's keys and moved
 * to the current one, unless that key holds another element's draft: then
 * the draft keeps its own key. A sheet with no draft never takes a key that
 * holds another element's draft. Only drafts whose snippet is compatible
 * with `el`'s are resolved, so the scan stays cheap.
 */
export function resolveDraft(path: string, el: Element, snippet: string): { key: string; draft: NoteDraft | null } {
  const key = draftKey(path, el);
  const here = read(key);
  const own = draftFor(here, snippet, el);
  if (own) return { key, draft: own };

  for (const other of pageDraftKeys(path, key)) {
    const raw = read(other);
    const draft = draftFor(raw, snippet, el);
    if (!draft || !raw) continue;
    if (here) return { key: other, draft };
    try {
      sessionStorage.setItem(key, raw);
      sessionStorage.removeItem(other);
      return { key, draft };
    } catch {
      return { key: other, draft };
    }
  }

  if (!here) return { key, draft: null };
  // The key holds another element's draft: write this one beside it.
  let n = 2;
  while (read(`${key}#${n}`) !== null) n += 1;
  return { key: `${key}#${n}`, draft: null };
}

/**
 * The draft stored under `key`, if it was written for `el`: a compatible snippet,
 * and (see `draftBelongsTo`) its stored anchor still resolves to `el`. A draft
 * that does not belong is left in storage; its element may be off screen or
 * not rendered yet.
 */
export function loadDraft(key: string, snippet: string, el: Element): NoteDraft | null {
  return draftFor(read(key), snippet, el);
}

export function saveDraft(key: string, draft: NoteDraft): void {
  try {
    if (draft.text.trim() || draft.drawing?.strokes.length) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {
    // Private mode or quota: keep working without autosave.
  }
}

/** Whether any draft is stored under `key`, whatever element it was for. */
export function hasDraft(key: string): boolean {
  try {
    return sessionStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

export function clearDraft(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // See saveDraft.
  }
}

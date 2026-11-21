# Reference

Behaviour of the layer in detail: drafts, page conventions, gestures, pins, drawings, the
context it captures and theming. The REST contract is in [contract.md](contract.md); mounting
and configuration are in the [README](../README.md).

## Drafts

Unsaved drafts (text, type and marks) are kept in `sessionStorage` under `ann:draft:<path>|…`
and come back when the same element is picked again; storage failures are ignored, and stored
marks that fail validation are dropped. A draft comes back only onto its own element, by the same
never-guess rule as notes: its stored anchor must resolve to exactly the picked element, and the
anchor's `ancestor_snippets` must match (identical feedback rows differ only in the answer
around them). The stored anchor's `ann_id` must be the picked element's `data-ann` name in every
case, so two elements with the same text (the composer and its plan switcher) never share a
draft; a `data-ann-unique` element is then identified by that name. A draft started while an
answer was still streaming comes back after the answer has grown: the stored and current
snippets only need to start one with the other. In that case the text alone must tell repeats
apart (a stored introduction that several answers share gives no draft), since their position
could change. A draft that does not match
stays stored for when its element is back on screen.

The anchor, not the storage key, is a draft's identity. The key (name plus position among
same-named elements) is where a draft is usually found; when an older answer loads above, the
picked element's draft is found among this page's other drafts and moved to its new key. A draft
never takes over a key that holds another element's draft: it is written beside it instead.

## Page conventions

| Attribute | Meaning |
|---|---|
| `data-ann="<name>"` | A surface people comment on (`answer-body`, `citation-chip`, …). A pick lands on the nearest `[data-ann]` ancestor; the sheet shows the chain of `[data-ann]` ancestors as chips to widen the selection. Names may repeat (one per message); the note's text snippet and CSS path tell repeats apart. |
| `data-ann-unique` | On a `[data-ann]` element that appears once per page and whose text changes (a sidebar, a composer, a settings modal): the name alone finds it again. |
| `data-ann-dock` | A bar docked at the bottom of the screen (a composer). The pin button sits above it. |
| `data-ann-ui` | The layer's own UI. Picks, long-press and the anchor search skip it. |

A note is found again by its `data-ann` name, provided the element still contains the note's
text snippet (or carries `data-ann-unique`); then by CSS path, again with the snippet; then by a
search for the snippet.

**The layer never guesses.** Each step takes an element only when exactly one candidate
qualifies; otherwise the note shows as "moved" in the list instead of as a pin. Wherever it
chooses among candidates, a candidate's text must still contain the whole stored snippet (up to
200 characters, whitespace and case ignored), not just its start: answers often share a long
introduction. Text that grew after the snippet (a streaming answer) still matches; text edited
within it does not. A sole `data-ann` match only needs the first 60 characters.
- Repeats with the same name and text (every answer's feedback row) are told apart first by
  `ancestor_snippets`, the text of their `[data-ann]` ancestors (the answer around the row), and
  only then by the stored CSS path, which must select exactly one of them. A note on answer 2's
  row therefore stays on it when answer 1 goes away or older answers load above, and shows as
  moved once answer 2 is gone: every stored ancestor text needs a matching ancestor at its
  position, so a row outside any message does not qualify. The path keeps at most 8 levels, so
  it can select several elements on a deep page. Notes saved without `ancestor_snippets` rely on the path alone.
- The CSS-path step needs the path to select exactly one element that still has the snippet.
- The snippet search takes the element whose text starts with the snippet and is shortest; of
  nested elements with that text, the deepest. Two unrelated elements with that text are a tie,
  whether they are tagged or not: a tagged quote of an untagged paragraph does not win.

So a note on one section's quote never pins onto another section's quote, and an element whose
leading text changed shows as moved.
Untagged elements can be picked too. While notes are missing, the snippet search runs again after
page changes, at most once a second, so elements that render late are found.

## Gestures

**Touch**
- Long-press (450 ms, under 10 px of movement) outlines the element under the finger. Lifting
  the finger opens the note sheet for it. Moving more than 10 px before lifting draws a pen stroke
  instead and opens draw mode with it.
- Scrolling, moving early, or releasing early cancels the press, so scrolling never opens a note.
  Each press attaches a non-passive `touchmove` listener for its own length; it blocks scrolling
  only once the press has fired.
- A second finger (pinch-zoom, two-finger scroll) cancels the press at any point: before it fires
  nothing is armed; after, scrolling and zooming are released at once, nothing is picked, and a
  stroke in progress is dropped. Multi-touch never starts draw mode.
- Never starts inside `input`, `textarea`, `select`, `[contenteditable]` or the layer's UI.
- The release's click (on the pressed element, inside it, or on an ancestor such as the link it
  sits in) and Android's context menu are swallowed. After 200 ms of a still press,
  `ann-pressing` on `<html>` stops iOS text selection, the loupe and link previews.
- The pin button menu can turn long-press off.

**Desktop**
- ⌘-click (Ctrl-click elsewhere) picks; holding ⌘ outlines what is under the pointer.
- ⌘-drag (6 px or more) draws a stroke and opens draw mode with it. A ⌘-press never starts a text
  selection, and the click after a stroke neither picks nor follows a link.

**Pins** sit at each noted element's top end corner (top-left for right-to-left content), coloured
by status. Several notes on one element fan out toward the inline start, one 44 px tap target
each, 4 px apart; working notes come first, then open, then done. With more than three, the first
two keep their pins and a "+N" pin opens the notes list for that element, which links back to all
notes on the page. The row moves as a whole to stay on screen. A pin is hidden while something
else (an open modal) covers its element's corner; the check looks through the layer's own pins,
outlines and marks, which can sit over a small element such as a citation chip.

**Done pins** wear out. A done pin counts as seen once per page view (the layer mounting, or
`path` changing): the first time in it that the pin is on screen with a pin of its own. Re-renders,
scrolling and reloads of the list within a page view do not count again, and a done note behind a
"+N" pin is not counted. After 7 page views the pin stops showing; the pin on screen during the 7th
stays until the next page view, so it never vanishes under a finger. *Hide pin* in a done note's
sheet, and *Hide done pins* in the page's notes list, remove pins at once. Worn-out and hidden
notes stay in the notes list, with Reopen. Open and working notes are never affected.

Views and hides are kept in `storage` under `ann:done-pins` as JSON,
`{"<number>@<closed_at>": {"views": n, "hidden"?: true}}`, so a note reopened and closed again
starts fresh. Each write reads the stored value first (another tab's views are kept) and drops
entries for notes closed more than 8 days ago. The value is read again when a page view starts and
on a `storage` event for the key, so a pin hidden in another tab goes away at once; a pin that was
not worn out when the page view started still shows until the next one. A done note without `closed_at` always shows its
pin. When `storage` throws, views are not counted and done pins show as the server lists them;
hiding still works until the layer unmounts.

**Pin button** (bottom end corner): *Annotate* (tap to pick), *Draw*, *Notes on this page*,
*Long-press* on/off. It shows the count of open notes on the page. The menu follows the
menu-button pattern: Enter, Space or ArrowDown on the button opens it on the first item (ArrowUp
on the last); a click or tap opens it with focus on the menu itself, so no focus ring flashes.
ArrowUp / ArrowDown move through the items and wrap, Home / End jump to the ends. Escape, Tab and
Annotate close it and return focus to the button; Draw focuses the drawing toolbar, and leaving
draw mode returns focus to the button.

**Draw mode**: a transparent surface over the viewport takes every press as a stroke (red, 3 px,
round caps; each finished stroke is simplified with Ramer–Douglas–Peucker at 1.5 px). The page
does not scroll under it. Toolbar: Undo · Clear · Cancel · Done. Escape cancels. Done anchors the
note to the element under the centre of the strokes' bounding box and opens the note sheet; the
marks stay over the page, following the selected element, until the sheet closes.

Escape always belongs to the layer first (capture phase): it closes a sheet, leaves draw mode or
tap-to-pick, or closes the menu. Escape, swipe-down, the close button and the sheet's Cancel all ask before they
discard a note with text or marks; asking twice discards it.

**Focus**: a sheet takes focus when it opens (the note textarea when it was focused for a
keyboard pick, otherwise the close button) and gives it back on close, to the opener if it is
still on the page, else to the pin button. Below 768 px the sheet is modal (`aria-modal="true"`)
and Tab / Shift-Tab cycle inside it. At 768 px and up it is a side panel next to a page that stays
usable, so it is not modal and Tab can leave it.

## Drawings

`anchor.drawing = { strokes: [[[x, y], …], …], bbox: {x, y, w, h} }`. Coordinates are relative to
the anchor element's rect when it was picked: 0..1 is inside the element, values run from −10 to
10, rounded to 3 decimals. The layer keeps a drawing within 30 strokes, 400 points per stroke and
1,500 points in total: a long stroke is simplified further, and strokes past the limits are left
out with a notice in the sheet.

Opening a note (its pin, or "Show on page" in the list) draws its strokes over its element at the
element's current size.

## Context captured at pick time

When the element is picked (or Done is pressed), the layer records `context.viewport`
(`innerWidth`, `innerHeight`, `devicePixelRatio`), `context.scroll` (`scrollX`, `scrollY`), and
for every element of the widen chain its anchor (`css_path`, `text_snippet`,
`ancestor_snippets`) and `anchor.rect`. Save sends the selected element's pick-time anchor, and
the draft stores it too, so a streaming answer, a reordered list, the on-screen keyboard or the
sheet's own scrolling do not show in the note.

## REST contract

See [contract.md](contract.md).

## Theming

Every colour, font, radius, shadow and timing is a `--ann-*` custom property with a built-in
fallback; set them on `.ann-root` (which carries `data-theme`) or an ancestor. Colours used with an
alpha are space-separated RGB triplets.

| Variable | Default (dark) |
|---|---|
| `--ann-accent`, `--ann-accent-ink` | `167 139 250`, `20 12 40` |
| `--ann-open`, `--ann-working`, `--ann-done` | blue, amber, green triplets |
| `--ann-mark` | `239 68 68` (pen strokes) |
| `--ann-panel`, `--ann-sunken`, `--ann-ink`, `--ann-muted`, `--ann-line` | colours |
| `--ann-font`, `--ann-radius-surface`, `--ann-radius-control` | |
| `--ann-shadow-card`, `--ann-shadow-modal`, `--ann-ease`, `--ann-dur-fast`, `--ann-dur-base` | |
| `--ann-z` | `2147483000` |

The light theme (`data-theme="light"`) has its own defaults. `annotate.css` leaves vendor prefixes
such as `-webkit-user-select` to the host's CSS pipeline (Autoprefixer, Lightning CSS or similar).

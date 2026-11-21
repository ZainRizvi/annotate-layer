# REST contract

The layer reads and writes notes through three HTTP routes under one **endpoint** URL that the
host chooses, such as `https://api.example.com/api/admin/annotations`. `createFetchClient` (and
the `endpoint` prop) speak exactly this contract. A host that cannot serve it can pass its own
`AnnotateClient` instead (see the README).

| Method | Path | Body / query | Success |
|---|---|---|---|
| `GET` | `<endpoint>` | `?path=<page key>&state=all`, plus `&fresh=1` right after the layer's own writes | 200 `{"items": AnnotationItem[]}` |
| `POST` | `<endpoint>` | `CreateAnnotationInput` (JSON) | 201 `CreatedAnnotation` |
| `POST` | `<endpoint>/{number}/status` | `{"status": "open" \| "done"}` | 200 `AnnotationItem` |

Types are exported from the package (`CreateAnnotationInput`, `AnnotationItem`, …); the shapes
below are the same.

## Authentication

The server decides who may annotate. Every route must refuse a request from anyone else with
401 (not signed in) or 403 (signed in, not allowed) **before** touching storage. Loading the
layer only for allowed users is a bandwidth and UX measure, not a security boundary: the routes
are.

- Default: the client sends cookies (`credentials: 'include'`). For a cross-origin API, the
  server must answer CORS with `Access-Control-Allow-Credentials: true` and an explicit
  `Access-Control-Allow-Origin` (not `*`), and the session cookie must be `SameSite=None; Secure`
  (or the API must be same-site).
- Token auth: `createFetchClient({ endpoint, headers: () => ({ Authorization: 'Bearer …' }) })`.
  `headers` runs before every request.
- The server, not the client, records who wrote a note (`author`). Ignore any author the client
  sends.

## Errors

Errors use the shape `{"detail": string}` or, for validation, `{"detail": [{"msg": string, …}]}`
(FastAPI's shape; any JSON `detail` or `message` string works).

| Status | `detail` | Meaning | Layer shows |
|---|---|---|---|
| 401 / 403 | any | not allowed | "Sign in again as an admin" |
| 404 | `annotation_not_found` | status change on a note that is gone | drops the note |
| 422 | list or string | the payload breaks a limit below | the server's message |
| 422 | `annotation_too_large` | the stored note would be too large (the reference server: an issue body over 60,000 characters) | the server's message |
| 502 | short message | the storage backend failed | the message, with "Try again" |
| 503 | `annotations_not_configured` | storage is not set up on this server | "not set up" |

## `POST <endpoint>`: create a note

```json
{
  "text": "Button text is cut off on mobile",
  "type": "bug",
  "anchor": {
    "path": "/pricing",
    "url": "https://example.com/pricing?plan=team",
    "ann_id": "plan-card",
    "css_path": "main > section:nth-of-type(2) > div",
    "text_snippet": "Team plan $12 per seat",
    "ancestor_snippets": ["Team plan $12 per seat Start trial", "Pricing plans"],
    "rect": { "x": 24, "y": 310.5, "w": 320, "h": 180 },
    "drawing": {
      "strokes": [[[0.1, 0.2], [0.5, 0.9]], [[1.2, -0.3]]],
      "bbox": { "x": 0.1, "y": -0.3, "w": 1.1, "h": 1.2 }
    }
  },
  "context": {
    "viewport": { "w": 390, "h": 844, "dpr": 3 },
    "scroll": { "x": 0, "y": 1200 },
    "input": "touch",
    "env": "preview",
    "build_sha": "abc1234",
    "theme": "dark",
    "lang": "en",
    "ua": "Mozilla/5.0 …"
  }
}
```

| Field | Rule |
|---|---|
| `text` | 1–4000 characters after trimming |
| `type` | `bug` \| `design` \| `content` \| `question` |
| `anchor.path` | 1–2048 characters; the page key notes are grouped and listed by (the host's `path` prop) |
| `anchor.url` | 1–4096 characters; the full page URL |
| `anchor.ann_id` | optional, ≤ 200 characters; the element's `data-ann` name |
| `anchor.css_path` | 1–2000 characters; a CSS selector path of at most 8 levels |
| `anchor.text_snippet` | optional, ≤ 200 characters; the element's text, whitespace collapsed |
| `anchor.ancestor_snippets` | optional, 0–6 strings of 1–200 characters: the text of the element's `[data-ann]` ancestors, innermost first |
| `anchor.rect` | optional `{x, y, w, h}`: the element's box in viewport CSS pixels when it was picked; `w`, `h` ≥ 0 |
| `anchor.drawing` | optional. `strokes`: 1–30 strokes of 1–400 `[x, y]` points, ≤ 1500 points in all, each coordinate in [−10, 10] relative to the element's rect (0..1 is inside it). `bbox`: the strokes' bounding box `{x, y, w, h}` in the same relative units |
| `context.viewport` | `w`, `h` integers 0–100000; `dpr` > 0 and ≤ 20 |
| `context.scroll` | optional `{x, y}` |
| `context.input` | `touch` \| `pointer` |
| `context.env` | ≤ 32 characters (from the host's `context().env`) |
| `context.build_sha`, `theme`, `lang`, `ua` | optional; ≤ 64, 32, 16, 1000 characters |

Every number is finite. The layer never sends more than these limits, so a server may reject
anything larger with 422. Unknown fields should be ignored.

The layer captures no screenshot. The element's anchor, box, pen strokes, viewport, scroll,
theme, language, environment, build and user agent are enough for an agent to find the element
in the code and reproduce the view; a server that wants an image can render one from `url` and
`viewport`.

Response, 201:

```json
{ "number": 123, "html_url": "https://github.com/example/site/issues/123", "status": "open", "created_at": "2026-11-05T10:00:00Z" }
```

`number` is the note's id in the store (an issue number, a row id). `html_url` is where a person
reads the note; the layer links to it.

## `GET <endpoint>`: list notes

Query: `path` (exact match on `anchor.path`), `state=all`, and `fresh=1` when the layer has just
written. `state=all` means open notes plus notes closed recently (the reference server uses the
last 7 days), so finished work shows as green pins for a while.

```json
{
  "items": [{
    "number": 123,
    "html_url": "https://github.com/example/site/issues/123",
    "title": "[ann] Button text is cut off on mobile",
    "text": "Button text is cut off on mobile",
    "type": "bug",
    "status": "open",
    "anchor": { "path": "/pricing", "url": "…", "ann_id": "plan-card", "css_path": "…",
                "text_snippet": "…", "ancestor_snippets": ["…"], "rect": { "x": 24, "y": 310.5, "w": 320, "h": 180 },
                "drawing": null },
    "created_at": "2026-11-05T10:00:00Z",
    "updated_at": "2026-11-05T10:00:00Z",
    "closed_at": null,
    "author": "admin@example.com"
  }]
}
```

- Return the `anchor` as it was stored, including `drawing`. Missing values may be `null`.
- `status`: `open` (new), `working` (an agent or person has picked it up), `done` (closed).
- `closed_at`: when a done note was closed, `null` otherwise. A note reopened and closed again
  gets a new `closed_at`; the layer keys its "seen" counter for done pins on it.
- `type` and `author` may be `null`.
- Newest first is expected but not required.
- Caching is allowed; honour `fresh=1` so a note appears right after it is saved, even behind
  several server replicas.

## `POST <endpoint>/{number}/status`: close or reopen

Body `{"status": "done"}` closes the note; `{"status": "open"}` reopens it (and should clear any
`working` marker). Returns the note in the list-item shape. 404 `annotation_not_found` when the
note does not exist.

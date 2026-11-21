# annotate-github-fastapi

A FastAPI backend for [annotate-layer](../../README.md): admin notes pinned to
parts of a website. Each note is a GitHub issue in one repository, written by a
GitHub App, so notes outlive the environment they were written in and agents
can read them with `gh`.

The package (import name `annotate_github`) depends only on `fastapi`,
`pydantic`, `httpx` and `PyJWT`. It does not import the host app; the
host supplies authentication and settings through callbacks.

Install from this directory with `pip install .` (or `uv pip install .`).
`example_app.py` is a runnable app: `uvicorn example_app:app --reload`.

| File | Contents |
|---|---|
| `router.py` | `create_router`, the routes, the list cache |
| `schemas.py` | Request and response models with their limits |
| `issue_body.py` | Issue title and body: the `ann:v1` block, note, summary table |
| `github_client.py` | GitHub issues API calls (the only HTTP code besides auth) |
| `github_app_auth.py` | App JWT and installation tokens |
| `settings.py` | `AnnotateSettings` |

## Usage

```python
from annotate_github import AnnotateSettings, create_router

router = create_router(
    require_admin=get_current_admin,  # FastAPI dependency returning the admin
    author_of=lambda admin: admin.username or admin.email,
    settings=lambda: AnnotateSettings(
        app_id=os.environ["GITHUB_APP_ID"],
        private_key=os.environ["GITHUB_APP_PRIVATE_KEY"],
        installation_id=os.environ.get("GITHUB_APP_INSTALLATION_ID"),
        repo=os.environ["ANNOTATIONS_REPO"],  # "owner/name"
    ),
    prefix="/api/admin/annotations",  # default
    tags=["admin-annotations"],  # default ["annotations"]
)
app.include_router(router)
```

- `require_admin` runs on every route. It returns the admin, or raises
  (401/403) to refuse the request before any GitHub call.
- `author_of(admin)` is stored as the note's author. A client cannot set it.
- `settings()` is called on every request, so changed settings apply without
  rebuilding the router.
- `reset_caches()` clears the per-process caches (lists, tokens, installation
  IDs, ensured labels). Tests call it between cases.

Routes are relative to `prefix`, which the host chooses (default
`/api/admin/annotations`). The frontend's `createFetchClient({ endpoint })`
must point at that full prefix URL, for example
`https://api.example.com/api/admin/annotations`. When the frontend runs on
another origin and authenticates with cookies, the host adds CORS middleware
with an explicit `allow_origins` list and `allow_credentials=True`;
`example_app.py` shows this.

## Settings

| Field | Meaning |
|---|---|
| `app_id` | The GitHub App's ID |
| `private_key` | The App's private key (PEM). Literal `\n` sequences are read as newlines, so a one-line env value works. |
| `installation_id` | Optional. When blank or `None`, it is looked up from `repo` and cached. |
| `repo` | `owner/name` of the repository that holds the issues |

Without `app_id` and `private_key`, or with a key that cannot sign or a
non-numeric `installation_id`, every route answers 503
`annotations_not_configured`.

## GitHub App setup

1. Create a GitHub App owned by the account or organisation that owns the repository (Settings → Developer
   settings → GitHub Apps → New GitHub App).
   - Webhook: off.
   - Repository permissions: **Issues: Read and write**. No other permissions.
2. Generate a private key and keep the downloaded PEM.
3. Install the App on the one repository that holds the notes ("Only select
   repositories").
4. Set the App ID and private key (and optionally the installation ID, shown in
   the installation's URL) in the backend environment (the example reads `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID` and `ANNOTATIONS_REPO`). The key stays on the
   backend; the browser never sees it.

The backend signs a 9-minute JWT as the App, exchanges it for a one-hour
installation token scoped to `repo` and Issues, caches the token per (App,
repo) and renews it five minutes before it expires. A 401 from GitHub drops the
cached token. When the App is reinstalled (new installation ID), the token
request fails with 401 or 404, and the backend looks the installation up again
once.

## Storage

- Every note is an issue with label `annotation` and `ann-type:<type>`. Missing
  labels are created on first use (best effort).
- Status: `open` = open issue; `working` = open issue with label `ann:working`
  (set by agents); `done` = closed issue.
- Title: `[ann] ` + the first 70 characters of the note on one line.
- Body: an `<!-- ann:v1 {json} -->` block holding the anchor and context fields
  (including `drawing`), the type and the author, then `**Note**`, the note
  text, and a table:

  ```markdown
  | | |
  |---|---|
  | Page | https://example.com/pricing |
  | Element | `save-button` / `main > div:nth-of-type(2) > span` |
  | Device | 390×844 @3x · touch |
  | Build | preview abc1234 |
  | Marked | 3 strokes |
  ```

  `Marked` appears only when the note has a drawing. `<` and `>` in the JSON
  are written as `\u003c` and `\u003e`, so no value can end the comment.

## REST contract

All paths are under the router's prefix (default `/api/admin/annotations`).
Errors use FastAPI's `{"detail": ...}` shape.

| Status | `detail` | When |
|---|---|---|
| 401 / 403 | from `require_admin` | not signed in / not an admin |
| 404 | `annotation_not_found` | status change on an issue that is gone or is not an annotation |
| 422 | validation errors | the body breaks a limit below |
| 422 | `annotation_too_large` | the issue body would exceed 60,000 characters (GitHub's limit is 65,536) |
| 502 | short message | GitHub failed, timed out or returned something unexpected |
| 503 | `annotations_not_configured` | App settings missing or unusable |

### `POST ""` — create a note → 201

```json
{
  "text": "Button text is cut off on mobile",
  "type": "bug",
  "anchor": {
    "path": "/pricing",
    "url": "https://example.com/pricing",
    "ann_id": "save-button",
    "css_path": "main > div:nth-of-type(2) > span",
    "text_snippet": "Save changes",
    "ancestor_snippets": ["Pricing plans…", "Pricing"],
    "rect": {"x": 24, "y": 310.5, "w": 120, "h": 28},
    "drawing": {
      "strokes": [[[0.1, 0.2], [0.5, 0.9]], [[1.2, -0.3]]],
      "bbox": {"x": 30, "y": 300, "w": 140, "h": 60}
    }
  },
  "context": {
    "viewport": {"w": 390, "h": 844, "dpr": 3},
    "input": "touch",
    "env": "preview",
    "build_sha": "abc1234",
    "theme": "dark",
    "lang": "en",
    "ua": "Mozilla/5.0 …",
    "scroll": {"x": 0, "y": 1200}
  }
}
```

| Field | Rule |
|---|---|
| `text` | trimmed, 1–4000 chars |
| `type` | `bug` \| `design` \| `content` \| `question` |
| `anchor.path` | trimmed, 1–2048 chars; the page key notes are grouped by |
| `anchor.url` | trimmed, 1–4096 chars |
| `anchor.ann_id` | optional, ≤ 200 chars |
| `anchor.css_path` | trimmed, 1–2000 chars |
| `anchor.text_snippet` | optional, ≤ 200 chars, kept verbatim |
| `anchor.ancestor_snippets` | optional list of 0–6 strings, each trimmed and 1–200 chars: the text snippets of the element's `[data-ann]` ancestors, innermost first, used to tell identical repeated rows apart. Stored in the `ann:v1` block, not shown in the table. |
| `anchor.rect` | optional `{x, y, w, h}`: the element's box in viewport CSS px at pick time; finite, `w`, `h` ≥ 0 |
| `anchor.drawing.strokes` | optional; 1–30 strokes, each 1–400 `[x, y]` points, ≤ 1500 points in total; each coordinate finite and within [-10, 10], relative to the anchor element's rect (0..1 is inside it) |
| `anchor.drawing.bbox` | required with `drawing`: `{x, y, w, h}`, finite, `w`, `h` ≥ 0 |
| `context.viewport` | `w`, `h` integers 0–100000; `dpr` > 0 and ≤ 20 |
| `context.input` | `touch` \| `pointer` |
| `context.env` | ≤ 32 chars |
| `context.build_sha` / `theme` / `lang` / `ua` | optional; ≤ 64 / 32 / 16 / 1000 chars |
| `context.scroll` | optional `{x, y}`, finite |

Every number in `rect`, `drawing` and `scroll` is rounded to 3 decimals before
it is stored. NaN and infinities are refused. Unknown fields (such as
`author`) are ignored.

Response:

```json
{"number": 123, "html_url": "https://github.com/example/annotations/issues/123",
 "status": "open", "created_at": "2026-11-05T10:00:00Z"}
```

### `GET ""` — list notes → 200

Query: `path` (optional, exact match on `anchor.path`), `state=open|all`
(default `open`; `all` adds notes closed in the last 7 days), `fresh=1` (skip
the cache).

```json
{"items": [{
  "number": 123,
  "html_url": "https://github.com/example/annotations/issues/123",
  "title": "[ann] Button text is cut off on mobile",
  "text": "Button text is cut off on mobile",
  "type": "bug",
  "status": "open",
  "anchor": {
    "path": "/pricing", "url": "https://example.com/pricing",
    "ann_id": "save-button", "css_path": "main > div:nth-of-type(2) > span",
    "text_snippet": "Save changes",
    "ancestor_snippets": ["Pricing plans…", "Pricing"],
    "rect": {"x": 24.0, "y": 310.5, "w": 120.0, "h": 28.0},
    "drawing": {"strokes": [[[0.1, 0.2], [0.5, 0.9]], [[1.2, -0.3]]],
                "bbox": {"x": 30.0, "y": 300.0, "w": 140.0, "h": 60.0}}
  },
  "created_at": "2026-11-05T10:00:00Z",
  "updated_at": "2026-11-05T10:00:00Z",
  "closed_at": null,
  "author": "admin"
}]}
```

- Newest first. Every `anchor` key is present; missing values are `null`.
  `type` and `author` may be `null`.
- `closed_at` is the time GitHub closed the issue for a `done` note and `null`
  for an open or working one. A note that is reopened and closed again gets a
  new `closed_at`, so clients can key per-closing state on it.
- An `ancestor_snippets`, `rect` or `drawing` that no longer passes validation
  (an issue edited by hand) comes back as `null`; the note is still listed.
  Issues without a valid `ann:v1` block are skipped.
- Lists are cached per process for 30 seconds per (repo, state). A write
  through this process clears that repo's cache, but other replicas keep
  theirs, so a client sends `fresh=1` on the reload right after its own write.
- Up to 5 pages of 100 issues per state are read.

### `POST "/{number}/status"` — close or reopen → 200

Body: `{"status": "open" | "done"}`. `done` closes the issue. `open` first
removes `ann:working` (when the issue has it; a 404 counts as removed), then
reopens the issue. If removing the label fails, the answer is 502 and the issue
is not reopened, so the request can be retried. Returns the updated item in the
list-item shape.

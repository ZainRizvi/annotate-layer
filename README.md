# fixfast

Leave feedback on a live website by pointing at it. Reviewers you choose (admins, testers) long-press,
⌘-click or draw on any part of a page and write a note. Each note lands in a store the site's
backend owns. The reference backend stores notes as GitHub issues. An agent can then pick the
notes up, fix what they describe and open pull requests. When the fix ships, the pin on the page
turns green.

- **A React overlay.** It owns all the UI: the pin button, outlines, pen marks, the note sheet,
  pins on noted elements and the list of notes on the page. The host app only mounts it.
- **Loaded only for people allowed to use it.** Everyone else downloads none of it.
- **Your backend, your storage.** The layer calls one REST endpoint you configure. Your server
  checks who is calling and stores the note where you like. A FastAPI reference server that
  writes GitHub issues is included.
- **Built for agents.** Each note records where it was left: the element's anchor, its text, the
  pen strokes, the viewport, theme, language, environment and build. An agent can find the code
  and reproduce the view from that.

## Install

The package is on npm:

```bash
npm install fixfast
```

Peer dependencies: `react` and `react-dom` 19.

## Use

Mount it only for users who may annotate, and load it lazily so nobody else downloads it.

```tsx
// Annotate.tsx: the only file that imports the layer.
import 'fixfast/styles.css';
import { FixFast } from 'fixfast';

export default function Annotate({ path }: { path: string }) {
  return (
    <FixFast
      endpoint="https://api.example.com/api/admin/annotations"
      path={path} // notes are grouped by this page key
      context={() => ({ theme: 'light', lang: 'en', env: 'production', buildSha: 'abc1234' })}
    />
  );
}
```

```tsx
// Anywhere in the app shell.
import { lazy, Suspense } from 'react';
const Annotate = lazy(() => import('./Annotate'));

{user?.isAdmin && (
  <Suspense fallback={null}>
    <Annotate path={location.pathname} />
  </Suspense>
)}
```

Wrap it in an error boundary of your own, so a failed download (offline, a stale chunk after a
deploy) cannot take down the page. In Next.js, use `next/dynamic(() => import('./Annotate'), { ssr: false })`
instead of `lazy`.

Or use the small `lazy` entry. It loads the layer on first use, renders nothing if the download
fails, and tries again the next time it is enabled:

```tsx
import { createLazyFixFast } from 'fixfast/lazy';
const Annotate = createLazyFixFast(() => import('fixfast'));

<Annotate enabled={!!user?.isAdmin} endpoint="/api/admin/annotations" path={pathname} context={ctx} />
```

The styles still need importing (`fixfast/styles.css`) somewhere that only
loads with the layer, or globally. The stylesheet is about 17 KB (4 KB gzipped); the script about 24 KB gzipped.

### Props

| Prop | Type | |
|---|---|---|
| `endpoint` | `string` | URL of your notes collection. The layer sends cookies. |
| `client` | `AnnotateClient` | Instead of `endpoint`: `createFetchClient({ endpoint, headers, credentials, fetch })`, or your own `{list, create, setStatus}`. |
| `path` | `string` | The page key notes are stored and listed under. Changing it loads that page's notes. |
| `context` | `() => AnnotateHostContext` | `{theme: 'dark' \| 'light', lang, env, buildSha?}`, read on render and on save. |
| `longPress` | `{enabled, onChange}` | Optional. Lets the host keep the long-press toggle (for example on the reviewer's account). |
| `storage` | `{get, set}` | Optional. Where done-pin view counts are kept. Defaults to `localStorage`. |

For token auth:

```tsx
<FixFast
  client={createFetchClient({ endpoint, headers: () => ({ Authorization: `Bearer ${getToken()}` }) })}
  path={path}
  context={context}
/>
```

The package is ESM only.

### Mark up your page (optional, recommended)

Tag the surfaces people comment on, so notes find their element again after the page changes:

```html
<article data-ann="product-card">…</article>
<nav data-ann="sidebar" data-ann-unique>…</nav>   <!-- appears once; its text changes -->
<form data-ann="composer" data-ann-dock>…</form>  <!-- docked at the bottom: the pin button sits above it -->
```

Untagged elements can be noted too. See [docs/reference.md](docs/reference.md#page-conventions).

### Theme

Every colour, font, radius and shadow is a `--ann-*` CSS custom property. Map them to your design
tokens on `.ann-root`:

```css
.ann-root { --ann-panel: var(--surface); --ann-ink: var(--text); --ann-font: var(--font-ui); }
```

## Backend

Your server implements three routes under the endpoint: list, create and set status. They are
specified in [docs/contract.md](docs/contract.md), with the payload, the limits, the errors and
the auth rules. The server must refuse anyone who may not annotate. Hiding the layer is not
access control.

[`server/fastapi`](server/fastapi) is a FastAPI router you can install. It stores each note as a
GitHub issue through a GitHub App, with labels for type and status. Other stores work too: a
database table, a Linear or Jira ticket, a file. See [AGENTS.md](AGENTS.md#storing-feedback).

## Closing the loop

Notes are written for agents to act on. A scheduled agent:

1. lists open notes that nobody has picked up yet,
2. marks a note as `working`, so its pin turns amber,
3. triages it. Clear bugs and design or content fixes become a pull request that closes the note
   when it merges. Unclear notes get a question. Questions get an answer. Duplicates are closed.
4. never merges. A person reviews the PR.

When the PR merges, the issue closes, and the note's pin turns green for the reviewer who left
it. The [`annotation-triage` skill](skills/annotation-triage/SKILL.md) is a ready-made procedure
for Claude Code or any agent with `gh`.

## Development

```bash
npm install
npm run check   # typecheck, lint, tests, build
cd server/fastapi && uv venv && uv pip install -e '.[dev]' && uv run pytest
```

More detail: [docs/reference.md](docs/reference.md) covers gestures, pins, drafts, drawings and
what is captured. [AGENTS.md](AGENTS.md) is the integration guide for coding agents.

## License

MIT

---
name: integrate-fixt
description: Add the fixt feedback overlay to a React site, so admins can point at and draw on any part of a page and leave notes that the site's backend stores. Use when asked to add admin feedback, on-page annotations, or "leave a note for an agent" to a web app, or to wire a backend route for fixt.
---

# Integrate fixt

Source of truth: AGENTS.md and docs/contract.md in https://github.com/ZainRizvi/fixt.
Read both before starting.

1. **Find the host's pieces**: the auth check for "may annotate" (usually admin), the API origin,
   the router (for the page key), theme and language state, and the deployed commit env var.
2. **Install** `fixt` from npm (or pnpm, yarn).
   Commit the lockfile.
3. **Wrapper** (`Annotate.tsx`, one file): import `fixt/styles.css` and
   `Fixt`. Pass `endpoint` (full URL of the notes collection), `path` (route path plus
   only the query parameters that change the content), and `context` returning
   `{theme, lang, env, buildSha}`.
4. **Gate**: render the wrapper only when the user may annotate, through `next/dynamic` with
   `{ssr: false}` or `React.lazy`. Confirm in the build output that the layer is in its own chunk.
5. **Theme**: map `--ann-*` variables to the host's tokens on `.ann-root`.
6. **Tag surfaces**: add `data-ann="<name>"` to commentable components. Add `data-ann-unique` to
   one-per-page elements with changing text, and `data-ann-dock` to a bottom composer bar.
7. **Backend**: implement the three routes in docs/contract.md, or mount `server/fastapi`
   (`fixt_github.create_router`) for GitHub-issue storage, with the host's admin dependency
   as `require_admin`. Configure CORS with credentials when the API is on another origin.
8. **Tests**: guests render nothing and load nothing; admins get the layer; non-admins get 401
   or 403 on every route; a created note comes back in the list for its `path`.
9. Point the user at `skills/annotation-triage` to close the loop.

Do not trust the client for `author`. Do not treat hiding the UI as access control.

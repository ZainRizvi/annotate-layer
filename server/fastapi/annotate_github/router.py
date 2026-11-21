"""The annotations API: notes pinned to parts of a site, stored as GitHub issues.

``create_router`` builds the FastAPI router. Every route depends on the
host's ``require_admin``. Issues live in the settings' repo with label
``annotation`` (body format: ``annotate_github/issue_body.py``). Status maps to
GitHub as: open = open issue, working = open issue with label
``ann:working``, done = closed issue. Requests authenticate as a GitHub App
(``annotate_github/github_app_auth.py``). GitHub failures answer 502; missing or
unusable App settings answer 503 ``annotations_not_configured``.
"""

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, cast

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from pydantic import BaseModel, ValidationError

from annotate_github import github_app_auth, issue_body
from annotate_github import github_client as gh
from annotate_github.schemas import (
    AncestorSnippets,
    AnnotationItem,
    AnnotationList,
    AnnotationStatus,
    AnnotationType,
    CreateAnnotationRequest,
    CreateAnnotationResponse,
    Drawing,
    ListState,
    Rect,
    StatusChangeRequest,
)
from annotate_github.settings import AnnotateSettings

LIST_CACHE_SECONDS = 30.0
CLOSED_WINDOW = timedelta(days=7)

# (repo, state) -> (monotonic expiry, parsed items newest first, unfiltered by path)
_list_cache: Dict[Tuple[str, str], Tuple[float, List[AnnotationItem]]] = {}
# Bumped by every invalidation. A fetch stores its result only if no
# invalidation happened while it ran, so a write mid-fetch is never masked.
_cache_gen = 0


def invalidate_list_cache(repo: Optional[str] = None) -> None:
    """Drop cached lists for ``repo``, or for every repo when ``None``."""
    global _cache_gen
    _cache_gen += 1
    if repo is None:
        _list_cache.clear()
        return
    for key in [key for key in _list_cache if key[0] == repo]:
        del _list_cache[key]


def reset_caches() -> None:
    """Forget every per-process cache: lists, tokens, installation IDs and
    ensured labels."""
    invalidate_list_cache()
    github_app_auth.reset_cache()
    gh.reset_ensured_labels()


def _not_configured() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="annotations_not_configured",
    )


def _bad_gateway(e: gh.GitHubError, settings: AnnotateSettings) -> HTTPException:
    print(f"[Annotations] {e}")
    if e.status_code == 401:
        # The installation token was revoked (e.g. the App was reinstalled);
        # the next request fetches a new one.
        github_app_auth.forget_token(settings)
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))


async def _token(settings: AnnotateSettings) -> str:
    if not settings.is_configured:
        raise _not_configured()
    try:
        return await github_app_auth.installation_token(settings)
    except github_app_auth.AppNotConfigured as e:
        print(f"[Annotations] {e}")
        raise _not_configured() from e
    except gh.GitHubError as e:
        raise _bad_gateway(e, settings) from e


def _label_name(label: Any) -> Optional[str]:
    name = label.get("name") if isinstance(label, dict) else label
    return name if isinstance(name, str) else None


def _label_names(issue: Dict[str, Any]) -> List[str]:
    names = (_label_name(label) for label in issue.get("labels") or [])
    return [name for name in names if name is not None]


def _issue_status(issue: Dict[str, Any], labels: List[str]) -> AnnotationStatus:
    if issue.get("state") == "closed":
        return "done"
    if gh.WORKING_LABEL in labels:
        return "working"
    return "open"


def _issue_type(labels: List[str], meta: Dict[str, Any]) -> Optional[AnnotationType]:
    """The ``ann-type:`` label's type, else the block's ``type``."""
    candidates: List[Any] = [
        name[len(gh.TYPE_LABEL_PREFIX) :]
        for name in labels
        if name.startswith(gh.TYPE_LABEL_PREFIX)
    ]
    candidates.append(meta.get("type"))
    for candidate in candidates:
        if candidate in gh.ANNOTATION_TYPES:
            return cast(AnnotationType, candidate)
    return None


def _optional_str(value: Any) -> Optional[str]:
    return value if isinstance(value, str) else None


def _optional_model(model: type[BaseModel], value: Any) -> Any:
    """``value`` re-validated as ``model``, or ``None`` when it is missing or
    invalid (e.g. a block edited by hand on GitHub)."""
    if value is None:
        return None
    try:
        return model.model_validate(value).model_dump(mode="json")
    except ValidationError:
        return None


def issue_to_item(issue: Dict[str, Any]) -> Optional[AnnotationItem]:
    """The annotation an issue holds, or ``None`` for an issue that is a pull
    request, lacks the ``annotation`` label, or has no valid ``ann:v1`` block."""
    if "pull_request" in issue:
        return None
    labels = _label_names(issue)
    if gh.ANNOTATION_LABEL not in labels:
        return None
    parsed = issue_body.parse_issue_body(issue.get("body"))
    if parsed is None:
        return None
    meta, text = parsed
    try:
        return AnnotationItem(
            number=issue["number"],
            html_url=issue["html_url"],
            title=issue.get("title") or "",
            text=text,
            type=_issue_type(labels, meta),
            status=_issue_status(issue, labels),
            anchor={
                "path": meta["path"],
                "url": _optional_str(meta.get("url")),
                "ann_id": _optional_str(meta.get("ann_id")),
                "css_path": _optional_str(meta.get("css_path")),
                "text_snippet": _optional_str(meta.get("text_snippet")),
                "ancestor_snippets": _optional_model(
                    AncestorSnippets, meta.get("ancestor_snippets")
                ),
                "rect": _optional_model(Rect, meta.get("rect")),
                "drawing": _optional_model(Drawing, meta.get("drawing")),
            },
            created_at=issue["created_at"],
            updated_at=issue.get("updated_at") or issue["created_at"],
            closed_at=(
                _optional_str(issue.get("closed_at"))
                if issue.get("state") == "closed"
                else None
            ),
            author=_optional_str(meta.get("author")),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _parse_time(value: Any) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


async def _fetch_items(token: str, repo: str, state: ListState) -> List[AnnotationItem]:
    issues = await gh.list_issues(token, repo, "open")
    if state == "all":
        cutoff = datetime.now(timezone.utc) - CLOSED_WINDOW
        closed = await gh.list_issues(
            token, repo, "closed", since=cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")
        )
        for issue in closed:
            closed_at = _parse_time(issue.get("closed_at"))
            if closed_at is not None and closed_at >= cutoff:
                issues.append(issue)

    items: Dict[int, AnnotationItem] = {}
    for issue in issues:
        item = issue_to_item(issue)
        if item is not None:
            items[item.number] = item
    return sorted(items.values(), key=lambda i: i.created_at, reverse=True)


async def _cached_items(
    token: str, repo: str, state: ListState, fresh: bool = False
) -> List[AnnotationItem]:
    """Items for ``state`` from the cache, or from GitHub when the cache is
    empty, expired or ``fresh`` is set. A GitHub result is cached either way."""
    now = time.monotonic()
    cached = _list_cache.get((repo, state))
    if not fresh and cached is not None and cached[0] > now:
        return cached[1]
    generation = _cache_gen
    items = await _fetch_items(token, repo, state)
    if generation == _cache_gen:
        _list_cache[(repo, state)] = (now + LIST_CACHE_SECONDS, items)
    return items


def create_router(
    *,
    require_admin: Callable[..., Any],
    author_of: Callable[[Any], str],
    settings: Callable[[], AnnotateSettings],
    prefix: str = "/api/admin/annotations",
    tags: Optional[Sequence[str]] = None,
) -> APIRouter:
    """The annotations API.

    ``require_admin`` is a FastAPI dependency that returns the signed-in
    admin or raises (401/403). ``author_of(admin)`` names that admin in the
    issue. ``settings()`` is called on every request, so the host can change
    them without rebuilding the router.
    """
    router = APIRouter(
        prefix=prefix, tags=list(tags) if tags is not None else ["annotations"]
    )

    @router.post(
        "",
        response_model=CreateAnnotationResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_annotation(
        request: CreateAnnotationRequest,
        admin: Any = Depends(require_admin),
    ) -> CreateAnnotationResponse:
        """Create a GitHub issue for a note on part of the site."""
        current = settings()
        repo = current.repo
        meta: Dict[str, Any] = {
            **request.anchor.model_dump(mode="json", exclude_none=True),
            **request.context.model_dump(mode="json", exclude_none=True),
            "type": request.type,
            "author": author_of(admin),
        }
        body = issue_body.build_issue_body(meta, request.text)
        if len(body) > issue_body.MAX_BODY_CHARS:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="annotation_too_large",
            )
        token = await _token(current)
        labels = [gh.ANNOTATION_LABEL, f"{gh.TYPE_LABEL_PREFIX}{request.type}"]

        await gh.ensure_labels(token, repo, labels)
        try:
            issue = await gh.create_issue(
                token, repo, issue_body.make_title(request.text), body, labels
            )
        except gh.GitHubError as e:
            raise _bad_gateway(e, current) from e
        invalidate_list_cache(repo)

        try:
            return CreateAnnotationResponse(
                number=issue["number"],
                html_url=issue["html_url"],
                status="open",
                created_at=issue["created_at"],
            )
        except (KeyError, TypeError, ValueError) as e:
            raise _bad_gateway(
                gh.GitHubError("GitHub returned an unexpected issue"), current
            ) from e

    @router.get("", response_model=AnnotationList)
    async def list_annotations(
        path: Optional[str] = Query(None, max_length=2048),
        state: ListState = Query("open"),
        fresh: bool = Query(False),
        _admin: Any = Depends(require_admin),
    ) -> AnnotationList:
        """Open annotations, newest first; ``state=all`` adds those closed in
        the last 7 days. ``path`` keeps only notes anchored on that page path.

        The cache is per process, so a write served by another replica does
        not clear it here; ``fresh=1`` skips the cached copy and refreshes it."""
        current = settings()
        token = await _token(current)
        try:
            items = await _cached_items(token, current.repo, state, fresh)
        except gh.GitHubError as e:
            raise _bad_gateway(e, current) from e
        if path is not None:
            items = [item for item in items if item.anchor.get("path") == path]
        return AnnotationList(items=items)

    @router.post("/{number}/status", response_model=AnnotationItem)
    async def change_annotation_status(
        request: StatusChangeRequest,
        number: int = Path(ge=1),
        _admin: Any = Depends(require_admin),
    ) -> AnnotationItem:
        """Close (``done``) or reopen (``open``) an annotation's issue.
        Reopening removes ``ann:working`` first, so a failure leaves the issue
        closed and the request can be retried."""
        current = settings()
        token = await _token(current)
        repo = current.repo
        not_found = HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="annotation_not_found"
        )
        try:
            existing = await gh.get_issue(token, repo, number)
        except gh.GitHubError as e:
            if e.status_code in (404, 410):
                raise not_found from e
            raise _bad_gateway(e, current) from e
        if issue_to_item(existing) is None:
            raise not_found

        try:
            if request.status == "open" and gh.WORKING_LABEL in _label_names(existing):
                # Removed before reopening, so a failure leaves the issue as
                # it was and the admin can retry. A 404 counts as removed.
                try:
                    await gh.remove_label(token, repo, number, gh.WORKING_LABEL)
                except gh.GitHubError as e:
                    raise _bad_gateway(e, current) from e
            target = "closed" if request.status == "done" else "open"
            try:
                updated = await gh.set_issue_state(token, repo, number, target)
            except gh.GitHubError as e:
                raise _bad_gateway(e, current) from e
        finally:
            invalidate_list_cache(repo)

        if request.status == "open":
            # GitHub's response can predate the label removal.
            updated["labels"] = [
                label
                for label in updated.get("labels") or []
                if _label_name(label) != gh.WORKING_LABEL
            ]

        item = issue_to_item(updated)
        if item is None:
            raise _bad_gateway(
                gh.GitHubError("GitHub returned an unexpected issue"), current
            )
        return item

    return router

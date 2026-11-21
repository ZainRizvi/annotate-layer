"""GitHub issues as storage for annotations.

Each annotation is an issue labelled ``annotation`` (body format:
``fixt_github/issue_body.py``). These HTTP helpers (``create_issue``,
``get_issue``, ``list_issues``, ``set_issue_state``, ``remove_label``,
``ensure_labels``) are the only code that talks to the GitHub issues API;
tests replace them.
"""

import logging
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import httpx

logger = logging.getLogger("fixt_github")

API_HOST = "api.github.com"
API_BASE = f"https://{API_HOST}"
TIMEOUT_SECONDS = 10.0
API_VERSION = "2022-11-28"

ANNOTATION_LABEL = "annotation"
WORKING_LABEL = "ann:working"
TYPE_LABEL_PREFIX = "ann-type:"
ANNOTATION_TYPES = ("bug", "design", "content", "question")
MAX_LIST_PAGES = 5

_LABEL_COLORS = {
    ANNOTATION_LABEL: "5319e7",
    WORKING_LABEL: "fbca04",
    f"{TYPE_LABEL_PREFIX}bug": "d73a4a",
    f"{TYPE_LABEL_PREFIX}design": "1d76db",
    f"{TYPE_LABEL_PREFIX}content": "0e8a16",
    f"{TYPE_LABEL_PREFIX}question": "c5def5",
}

# Labels this process has already ensured exist in a repo, so label creation
# runs once per label per process instead of on every POST.
_ensured_labels: set[Tuple[str, str]] = set()


class GitHubError(Exception):
    """A GitHub request failed: network error, timeout or non-2xx status."""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code


def _headers(token: str) -> Dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": API_VERSION,
    }


async def _send(
    method: str,
    path: str,
    token: str,
    *,
    json_body: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
) -> httpx.Response:
    """One GitHub call; ``path`` is relative to the API or an absolute URL."""
    try:
        async with httpx.AsyncClient(
            base_url=API_BASE, timeout=TIMEOUT_SECONDS, headers=_headers(token)
        ) as client:
            response = await client.request(method, path, json=json_body, params=params)
    except httpx.TimeoutException as e:
        raise GitHubError(f"GitHub request timed out: {method} {path}") from e
    except httpx.HTTPError as e:
        raise GitHubError(f"GitHub request failed: {method} {path}: {e}") from e
    if response.status_code >= 400:
        raise GitHubError(
            f"GitHub returned {response.status_code} for {method} {path}",
            status_code=response.status_code,
        )
    return response


def _json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError as e:
        raise GitHubError("GitHub returned a body that is not JSON") from e


async def _request(
    method: str,
    path: str,
    token: str,
    *,
    json_body: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None,
) -> Any:
    return _json(await _send(method, path, token, json_body=json_body, params=params))


async def create_issue(
    token: str, repo: str, title: str, body: str, labels: List[str]
) -> Dict[str, Any]:
    return await _request(
        "POST",
        f"/repos/{repo}/issues",
        token,
        json_body={"title": title, "body": body, "labels": labels},
    )


async def get_issue(token: str, repo: str, number: int) -> Dict[str, Any]:
    return await _request("GET", f"/repos/{repo}/issues/{number}", token)


async def list_issues(
    token: str, repo: str, state: str, since: Optional[str] = None
) -> List[Dict[str, Any]]:
    """``annotation`` issues in ``state``, newest first, following the
    ``Link: rel="next"`` header for up to ``MAX_LIST_PAGES`` pages of 100."""
    params: Dict[str, Any] = {
        "labels": ANNOTATION_LABEL,
        "state": state,
        "sort": "created",
        "direction": "desc",
        "per_page": 100,
    }
    if since:
        params["since"] = since
    issues: List[Dict[str, Any]] = []
    response = await _send("GET", f"/repos/{repo}/issues", token, params=params)
    for page in range(1, MAX_LIST_PAGES + 1):
        result = _json(response)
        if not isinstance(result, list):
            raise GitHubError("GitHub returned a non-list issue listing")
        issues.extend(result)
        next_url = response.links.get("next", {}).get("url")
        if not next_url:
            return issues
        parsed_next = httpx.URL(next_url)
        if parsed_next.scheme != "https" or parsed_next.host != API_HOST:
            # The token goes with every request, so only GitHub's API host
            # is followed.
            logger.warning(
                f"[Annotations] Warning: not following next-page link to "
                f"another host: {next_url}"
            )
            return issues
        if page == MAX_LIST_PAGES:
            logger.warning(
                f"[Annotations] Warning: more than {MAX_LIST_PAGES * 100} "
                f"{state} annotation issues in {repo}; listing the newest "
                f"{len(issues)} only"
            )
            return issues
        response = await _send("GET", next_url, token)
    return issues


async def set_issue_state(
    token: str, repo: str, number: int, state: str
) -> Dict[str, Any]:
    return await _request(
        "PATCH", f"/repos/{repo}/issues/{number}", token, json_body={"state": state}
    )


async def remove_label(token: str, repo: str, number: int, name: str) -> None:
    """Remove label ``name`` from an issue. A 404 (label not on the issue)
    counts as removed."""
    try:
        await _request(
            "DELETE",
            f"/repos/{repo}/issues/{number}/labels/{quote(name, safe='')}",
            token,
        )
    except GitHubError as e:
        if e.status_code != 404:
            raise


async def ensure_labels(token: str, repo: str, labels: List[str]) -> None:
    """Create any of ``labels`` missing from ``repo``. Best effort, never raises.

    GitHub answers 422 for a label that already exists; that counts as ensured.
    """
    for name in labels:
        if (repo, name) in _ensured_labels:
            continue
        try:
            await _request(
                "POST",
                f"/repos/{repo}/labels",
                token,
                json_body={"name": name, "color": _LABEL_COLORS.get(name, "ededed")},
            )
        except GitHubError as e:
            if e.status_code != 422:
                logger.warning(f"[Annotations] Could not create label {name!r}: {e}")
                continue
        _ensured_labels.add((repo, name))


def reset_ensured_labels() -> None:
    """Forget which labels were ensured, so the next POST creates them again."""
    _ensured_labels.clear()

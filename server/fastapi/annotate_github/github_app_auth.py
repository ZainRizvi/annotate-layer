"""GitHub App authentication for the annotation issues.

The backend signs a short-lived JWT with the App's private key, finds the
App's installation on the settings' repo, and exchanges the JWT for an
installation token limited to that one repository and to Issues read/write.
Installation tokens last an hour; one is cached per (App, repo) per process
and replaced five minutes before it expires.
"""

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Optional, Tuple

import jwt

from annotate_github.github_client import GitHubError, _request
from annotate_github.settings import AnnotateSettings

# GitHub rejects App JWTs that live longer than 10 minutes; ``iat`` is
# backdated a minute to allow for clock drift.
_JWT_BACKDATE_SECONDS = 60
_JWT_LIFETIME_SECONDS = 9 * 60
_REFRESH_MARGIN_SECONDS = 5 * 60


class AppNotConfigured(Exception):
    """The App ID or private key is missing, or the key cannot sign."""


@dataclass
class _CachedToken:
    token: str
    expires_at: float


# Keyed by (app_id, repo).
_cached: Dict[Tuple[str, str], _CachedToken] = {}
_installation_ids: Dict[Tuple[str, str], int] = {}
_lock = asyncio.Lock()


def _key(settings: AnnotateSettings) -> Tuple[str, str]:
    return (str(settings.app_id).strip(), settings.repo)


def _private_key(settings: AnnotateSettings) -> str:
    # Env stores often hold a PEM on one line with literal ``\n``.
    return settings.private_key.replace("\\n", "\n").strip()


def app_jwt(settings: AnnotateSettings, now: Optional[float] = None) -> str:
    """A JWT that authenticates as the App itself (not an installation)."""
    if not settings.is_configured:
        raise AppNotConfigured("GitHub App ID or private key is unset")
    issued = int(now if now is not None else time.time())
    claims = {
        "iat": issued - _JWT_BACKDATE_SECONDS,
        "exp": issued + _JWT_LIFETIME_SECONDS,
        "iss": str(settings.app_id).strip(),
    }
    try:
        return jwt.encode(claims, _private_key(settings), algorithm="RS256")
    except (jwt.PyJWTError, ValueError, TypeError) as e:
        raise AppNotConfigured(f"GitHub App private key cannot sign: {e}") from e


async def _installation_id(settings: AnnotateSettings, app_token: str) -> int:
    configured = str(settings.installation_id or "").strip()
    if configured:
        try:
            return int(configured)
        except ValueError as e:
            raise AppNotConfigured("GitHub App installation ID is not a number") from e
    key = _key(settings)
    if key not in _installation_ids:
        data = await _request("GET", f"/repos/{settings.repo}/installation", app_token)
        try:
            _installation_ids[key] = int(data["id"])
        except (KeyError, TypeError, ValueError) as e:
            raise GitHubError("GitHub returned an unexpected installation") from e
    return _installation_ids[key]


def _parse_expiry(value: object) -> float:
    if not isinstance(value, str):
        raise GitHubError("GitHub returned an installation token without expires_at")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError as e:
        raise GitHubError(f"GitHub returned an unreadable expires_at: {value}") from e


async def _exchange(settings: AnnotateSettings, app_token: str) -> object:
    installation = await _installation_id(settings, app_token)
    return await _request(
        "POST",
        f"/app/installations/{installation}/access_tokens",
        app_token,
        json_body={
            "repositories": [settings.repo.split("/", 1)[-1]],
            "permissions": {"issues": "write"},
        },
    )


async def installation_token(settings: AnnotateSettings) -> str:
    """A token for ``settings.repo`` with Issues read/write.

    Raises ``AppNotConfigured`` when the App settings are missing or unusable
    and ``GitHubError`` when GitHub refuses or cannot be reached (for example
    when the App is not installed on the repository)."""
    key = _key(settings)
    async with _lock:
        now = time.time()
        cached = _cached.get(key)
        if cached is not None and cached.expires_at - _REFRESH_MARGIN_SECONDS > now:
            return cached.token
        app_token = app_jwt(settings, now)
        try:
            data = await _exchange(settings, app_token)
        except GitHubError as e:
            # A reinstalled App has a new installation ID; look it up again.
            if e.status_code not in (401, 404) or key not in _installation_ids:
                raise
            del _installation_ids[key]
            data = await _exchange(settings, app_token)
        if not isinstance(data, dict):
            raise GitHubError("GitHub returned an unexpected installation token")
        token = data.get("token")
        if not isinstance(token, str) or not token:
            raise GitHubError(
                "GitHub returned an installation token response without a token"
            )
        expires_at = _parse_expiry(data.get("expires_at"))
        _cached[key] = _CachedToken(token=token, expires_at=expires_at)
        return token


def forget_token(settings: AnnotateSettings) -> None:
    """Drop the cached token for these settings, e.g. after GitHub rejected
    it as revoked."""
    _cached.pop(_key(settings), None)


def reset_cache() -> None:
    """Forget every cached token and installation ID."""
    _cached.clear()
    _installation_ids.clear()

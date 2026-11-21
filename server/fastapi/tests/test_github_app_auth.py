"""annotate_github.github_app_auth with an httpx MockTransport and a real RSA key."""

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, List

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jose import jwt

REPO = "example/annotations"


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


@pytest.fixture(scope="module")
def key_pair():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_pem = (
        key.public_key()
        .public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        .decode()
    )
    return SimpleNamespace(private=private_pem, public=public_pem)


@pytest.fixture()
def app(monkeypatch, key_pair):
    from annotate_github import AnnotateSettings
    from annotate_github import github_app_auth as auth
    from annotate_github import github_client as gh

    settings = AnnotateSettings(
        app_id="12345",
        # One-line PEM with literal "\n", as env stores often hold it.
        private_key=key_pair.private.replace("\n", "\\n"),
        installation_id="",
        repo=REPO,
    )
    auth.reset_cache()

    seen: List[httpx.Request] = []
    responses: List[Any] = []
    real_client = httpx.AsyncClient

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return responses.pop(0)

    def client(**kwargs):
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(gh.httpx, "AsyncClient", client)
    yield SimpleNamespace(
        auth=auth,
        gh=gh,
        settings=settings,
        seen=seen,
        responses=responses,
        monkeypatch=monkeypatch,
    )
    auth.reset_cache()


def _token_response(token: str, expires_in: timedelta) -> httpx.Response:
    expires = datetime.now(timezone.utc) + expires_in
    return httpx.Response(201, json={"token": token, "expires_at": _iso(expires)})


def test_app_jwt_is_signed_by_the_app_key(app, key_pair):
    token = app.auth.app_jwt(app.settings, now=1_000_000)
    claims = jwt.decode(
        token,
        key_pair.public,
        algorithms=["RS256"],
        options={"verify_exp": False, "verify_iat": False},
    )
    assert claims == {"iat": 1_000_000 - 60, "exp": 1_000_000 + 540, "iss": "12345"}


def test_unusable_key_is_not_configured(app):
    settings = replace(app.settings, private_key="not a pem")
    with pytest.raises(app.auth.AppNotConfigured):
        app.auth.app_jwt(settings)


def test_missing_settings_are_not_configured(app):
    settings = replace(app.settings, app_id="")
    assert not settings.is_configured
    with pytest.raises(app.auth.AppNotConfigured):
        app.auth.app_jwt(settings)


@pytest.mark.asyncio
async def test_finds_installation_then_requests_a_repo_scoped_token(app, key_pair):
    app.responses.extend(
        [
            httpx.Response(200, json={"id": 777}),
            _token_response("ghs_first", timedelta(hours=1)),
        ]
    )
    assert await app.auth.installation_token(app.settings) == "ghs_first"

    lookup, exchange = app.seen
    assert lookup.method == "GET"
    assert str(lookup.url) == f"https://api.github.com/repos/{REPO}/installation"
    assert exchange.method == "POST"
    assert (
        str(exchange.url)
        == "https://api.github.com/app/installations/777/access_tokens"
    )
    assert json.loads(exchange.content) == {
        "repositories": ["annotations"],
        "permissions": {"issues": "write"},
    }
    for request in (lookup, exchange):
        bearer = request.headers["Authorization"].removeprefix("Bearer ")
        assert (
            jwt.decode(bearer, key_pair.public, algorithms=["RS256"])["iss"] == "12345"
        )


@pytest.mark.asyncio
async def test_reuses_the_token_until_five_minutes_before_expiry(app):
    app.responses.extend(
        [
            httpx.Response(200, json={"id": 777}),
            _token_response("ghs_first", timedelta(minutes=30)),
        ]
    )
    assert await app.auth.installation_token(app.settings) == "ghs_first"
    assert await app.auth.installation_token(app.settings) == "ghs_first"
    assert len(app.seen) == 2

    app.auth._cached[("12345", REPO)].expires_at = app.auth.time.time() + 4 * 60
    app.responses.append(_token_response("ghs_second", timedelta(hours=1)))
    assert await app.auth.installation_token(app.settings) == "ghs_second"
    # The installation ID is remembered; only the token is fetched again.
    assert len(app.seen) == 3
    assert app.seen[2].url.path == "/app/installations/777/access_tokens"


@pytest.mark.asyncio
async def test_configured_installation_id_skips_the_lookup(app):
    settings = replace(app.settings, installation_id=42)
    app.responses.append(_token_response("ghs_direct", timedelta(hours=1)))
    assert await app.auth.installation_token(settings) == "ghs_direct"
    assert [r.url.path for r in app.seen] == ["/app/installations/42/access_tokens"]


@pytest.mark.asyncio
async def test_app_not_installed_is_a_github_error(app):
    app.responses.append(httpx.Response(404, json={"message": "Not Found"}))
    with pytest.raises(app.gh.GitHubError) as info:
        await app.auth.installation_token(app.settings)
    assert info.value.status_code == 404


@pytest.mark.asyncio
async def test_token_response_without_token_is_a_github_error(app):
    app.responses.extend(
        [httpx.Response(200, json={"id": 777}), httpx.Response(201, json={})]
    )
    with pytest.raises(app.gh.GitHubError):
        await app.auth.installation_token(app.settings)


@pytest.mark.asyncio
async def test_malformed_installation_id_is_not_configured(app):
    settings = replace(app.settings, installation_id="my-app")
    with pytest.raises(app.auth.AppNotConfigured):
        await app.auth.installation_token(settings)
    assert app.seen == []


@pytest.mark.asyncio
async def test_reinstalled_app_is_looked_up_again(app):
    app.responses.extend(
        [
            httpx.Response(200, json={"id": 777}),
            _token_response("ghs_first", timedelta(hours=1)),
        ]
    )
    assert await app.auth.installation_token(app.settings) == "ghs_first"

    app.auth.forget_token(app.settings)
    app.responses.extend(
        [
            httpx.Response(404, json={"message": "Not Found"}),
            httpx.Response(200, json={"id": 888}),
            _token_response("ghs_after_reinstall", timedelta(hours=1)),
        ]
    )
    assert await app.auth.installation_token(app.settings) == "ghs_after_reinstall"
    assert [r.url.path for r in app.seen[2:]] == [
        "/app/installations/777/access_tokens",
        f"/repos/{REPO}/installation",
        "/app/installations/888/access_tokens",
    ]


@pytest.mark.asyncio
async def test_tokens_are_cached_per_repo(app):
    other = replace(app.settings, repo="example/other", installation_id=9)
    app.responses.extend(
        [
            httpx.Response(200, json={"id": 777}),
            _token_response("ghs_annotations", timedelta(hours=1)),
            _token_response("ghs_other", timedelta(hours=1)),
        ]
    )
    assert await app.auth.installation_token(app.settings) == "ghs_annotations"
    assert await app.auth.installation_token(other) == "ghs_other"
    assert json.loads(app.seen[-1].content)["repositories"] == ["other"]

    app.auth.forget_token(other)
    assert await app.auth.installation_token(app.settings) == "ghs_annotations"
    assert len(app.seen) == 3

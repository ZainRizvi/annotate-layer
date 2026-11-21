"""The annotation router through a TestClient, with GitHub replaced by a fake.

The fake stands in for the HTTP helpers of fixfast_github.github_client
(create_issue, get_issue, list_issues, set_issue_state, remove_label,
ensure_labels), so no test reaches the network. The ``env`` fixture mounts
``create_router`` with a fake ``require_admin`` dependency that can be toggled
to answer 401 or 403.
"""

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

BASE = "/api/admin/annotations"
REPO = "example/annotations"
HTML = "https://github.com/example/annotations/issues"


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


NOW = datetime.now(timezone.utc)
_BUILD = object()


def _payload(**overrides: Any) -> Dict[str, Any]:
    body: Dict[str, Any] = {
        "text": "  Button text is cut off on mobile  ",
        "type": "bug",
        "anchor": {
            "path": "/c/8f2e41",
            "url": "https://example.com/c/8f2e41",
            "ann_id": "save-button",
            "css_path": "main > div:nth-of-type(2) > span",
            "text_snippet": "Button text",
        },
        "context": {
            "viewport": {"w": 390, "h": 844, "dpr": 3},
            "input": "touch",
            "env": "preview",
            "build_sha": "abc1234",
            "theme": "dark",
            "lang": "en",
            "ua": "Mozilla/5.0",
        },
    }
    body.update(overrides)
    return body


class FakeGitHub:
    """In-memory issues plus a record of every call the routes make."""

    def __init__(self, gh, body):
        self.gh = gh
        self.body = body
        self.issues: Dict[int, Dict[str, Any]] = {}
        self.calls: List[tuple] = []
        self.next_number = 100
        self.fail: Optional[Exception] = None

    def add(
        self,
        meta: Optional[Dict[str, Any]],
        text: str = "note",
        *,
        state: str = "open",
        labels: Optional[List[str]] = None,
        body: Any = _BUILD,
        created: Optional[datetime] = None,
        closed: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        number = self.next_number
        self.next_number += 1
        created = created or NOW - timedelta(hours=number)
        issue = {
            "number": number,
            "html_url": f"{HTML}/{number}",
            "title": f"[ann] {text}",
            "body": self.body.build_issue_body(meta, text) if body is _BUILD else body,
            "state": state,
            "labels": [{"name": n} for n in (labels or ["annotation", "ann-type:bug"])],
            "created_at": _iso(created),
            "updated_at": _iso(created),
            "closed_at": _iso(closed) if closed else None,
        }
        self.issues[number] = issue
        return issue

    def _check(self):
        if self.fail is not None:
            raise self.fail

    async def create_issue(self, token, repo, title, body, labels):
        self.calls.append(("create_issue", token, repo, title, body, labels))
        self._check()
        number = self.next_number
        self.next_number += 1
        issue = {
            "number": number,
            "html_url": f"{HTML}/{number}",
            "title": title,
            "body": body,
            "state": "open",
            "labels": [{"name": n} for n in labels],
            "created_at": _iso(NOW),
            "updated_at": _iso(NOW),
            "closed_at": None,
        }
        self.issues[number] = issue
        return issue

    async def get_issue(self, token, repo, number):
        self.calls.append(("get_issue", repo, number))
        self._check()
        if number not in self.issues:
            raise self.gh.GitHubError("GitHub returned 404", status_code=404)
        return dict(self.issues[number])

    async def list_issues(self, token, repo, state, since=None):
        self.calls.append(("list_issues", repo, state, since))
        self._check()
        return [dict(i) for i in self.issues.values() if i["state"] == state]

    async def set_issue_state(self, token, repo, number, state):
        self.calls.append(("set_issue_state", repo, number, state))
        self._check()
        issue = self.issues[number]
        issue["state"] = state
        issue["closed_at"] = _iso(NOW) if state == "closed" else None
        return dict(issue)

    async def remove_label(self, token, repo, number, name):
        self.calls.append(("remove_label", repo, number, name))
        self._check()
        issue = self.issues[number]
        issue["labels"] = [lb for lb in issue["labels"] if lb["name"] != name]

    async def ensure_labels(self, token, repo, labels):
        self.calls.append(("ensure_labels", repo, list(labels)))

    def names(self) -> List[str]:
        return [c[0] for c in self.calls]


@pytest.fixture()
def env(monkeypatch):
    import fixfast_github
    from fixfast_github import (
        AnnotateSettings,
        create_router,
        github_app_auth,
        issue_body,
    )
    from fixfast_github import github_client as gh
    from fixfast_github import router as ann_router

    fixfast_github.reset_caches()

    fake = FakeGitHub(gh, issue_body)
    for name in (
        "create_issue",
        "get_issue",
        "list_issues",
        "set_issue_state",
        "remove_label",
        "ensure_labels",
    ):
        monkeypatch.setattr(gh, name, getattr(fake, name))

    async def _installation_token(settings):
        assert settings.repo == REPO
        return "test-token"

    monkeypatch.setattr(github_app_auth, "installation_token", _installation_token)

    state = SimpleNamespace(
        user=SimpleNamespace(username="admin-ann", email="admin@example.com"),
        refuse=None,
        app_id="12345",
        private_key="unused-key",
    )

    def require_admin():
        if state.refuse is not None:
            raise HTTPException(status_code=state.refuse, detail="refused")
        return state.user

    def settings() -> AnnotateSettings:
        return AnnotateSettings(
            app_id=state.app_id, private_key=state.private_key, repo=REPO
        )

    app = FastAPI()
    app.include_router(
        create_router(
            require_admin=require_admin,
            author_of=lambda admin: admin.username or admin.email,
            settings=settings,
            prefix=BASE,
        )
    )

    def login(user):
        state.user = user
        state.refuse = None

    def refuse(status_code):
        state.refuse = status_code

    try:
        yield SimpleNamespace(
            client=TestClient(app),
            fake=fake,
            gh=gh,
            body=issue_body,
            app_auth=github_app_auth,
            routes=ann_router,
            state=state,
            login=login,
            refuse=refuse,
            monkeypatch=monkeypatch,
        )
    finally:
        fixfast_github.reset_caches()


def _meta(path: str = "/c/8f2e41", **extra: Any) -> Dict[str, Any]:
    return {
        "path": path,
        "url": f"https://example.com{path}",
        "ann_id": "hero-text",
        "css_path": "main > p",
        "author": "someone",
        **extra,
    }


class TestAccess:
    def test_unauthenticated_gets_401(self, env):
        env.refuse(401)
        assert env.client.get(BASE).status_code == 401
        assert env.client.post(BASE, json=_payload()).status_code == 401
        response = env.client.post(f"{BASE}/1/status", json={"status": "done"})
        assert response.status_code == 401
        assert env.fake.calls == []

    def test_non_admin_gets_403(self, env):
        env.refuse(403)
        assert env.client.get(BASE).status_code == 403
        assert env.client.post(BASE, json=_payload()).status_code == 403
        response = env.client.post(f"{BASE}/1/status", json={"status": "done"})
        assert response.status_code == 403
        assert env.fake.calls == []

    def test_missing_app_settings_give_503(self, env):
        env.state.private_key = ""
        for response in (
            env.client.get(BASE),
            env.client.post(BASE, json=_payload()),
            env.client.post(f"{BASE}/1/status", json={"status": "done"}),
        ):
            assert response.status_code == 503
            assert response.json()["detail"] == "annotations_not_configured"
        assert env.fake.calls == []

    def test_unusable_key_gives_503_and_github_refusal_gives_502(self, env):
        auth = env.app_auth

        async def bad_key(settings):
            raise auth.AppNotConfigured("GitHub App private key cannot sign")

        env.monkeypatch.setattr(auth, "installation_token", bad_key)
        response = env.client.get(BASE)
        assert response.status_code == 503
        assert response.json()["detail"] == "annotations_not_configured"

        async def not_installed(settings):
            raise env.gh.GitHubError("GitHub returned 404", status_code=404)

        env.monkeypatch.setattr(auth, "installation_token", not_installed)
        assert env.client.get(BASE).status_code == 502
        assert env.fake.calls == []

    def test_github_401_drops_the_cached_app_token(self, env):
        forgotten = []
        env.monkeypatch.setattr(
            env.app_auth, "forget_token", lambda s: forgotten.append(s.repo)
        )
        env.fake.fail = env.gh.GitHubError("GitHub returned 401", status_code=401)
        assert env.client.get(BASE).status_code == 502
        assert forgotten == [REPO]


class TestCreate:
    def test_builds_issue_with_labels_title_and_block(self, env):
        response = env.client.post(BASE, json=_payload())
        assert response.status_code == 201
        data = response.json()
        assert data == {
            "number": 100,
            "html_url": f"{HTML}/100",
            "status": "open",
            "created_at": _iso(NOW),
        }

        assert env.fake.names() == ["ensure_labels", "create_issue"]
        assert env.fake.calls[0] == (
            "ensure_labels",
            REPO,
            ["annotation", "ann-type:bug"],
        )
        _, token, repo, title, body, labels = env.fake.calls[1]
        assert token == "test-token"
        assert repo == REPO
        assert labels == ["annotation", "ann-type:bug"]
        assert title == "[ann] Button text is cut off on mobile"

        meta, text = env.body.parse_issue_body(body)
        assert text == "Button text is cut off on mobile"
        assert meta["path"] == "/c/8f2e41"
        assert meta["ann_id"] == "save-button"
        assert meta["css_path"] == "main > div:nth-of-type(2) > span"
        assert meta["viewport"] == {"w": 390, "h": 844, "dpr": 3}
        assert meta["input"] == "touch"
        assert meta["env"] == "preview"
        assert meta["build_sha"] == "abc1234"
        assert meta["author"] == "admin-ann"
        assert body.startswith("<!-- ann:v1\n")
        assert "**Note**\n\nButton text" in body
        assert "| Page | https://example.com/c/8f2e41 |" in body
        assert "| Device | 390×844 @3x · touch |" in body
        assert "| Build | preview abc1234 |" in body

    def test_title_truncates_to_70_chars_on_one_line(self, env):
        text = "word " * 40 + "\nsecond line"
        env.client.post(BASE, json=_payload(text=text))
        title = env.fake.calls[1][3]
        assert title.startswith("[ann] word word")
        assert len(title) == len("[ann] ") + 70
        assert "\n" not in title

    def test_author_comes_from_admin_not_client(self, env):
        payload = _payload(author="spoofed")
        payload["anchor"]["author"] = "spoofed"
        payload["context"]["author"] = "spoofed"
        env.client.post(BASE, json=payload)
        meta, _ = env.body.parse_issue_body(env.fake.calls[1][4])
        assert meta["author"] == "admin-ann"

    def test_author_falls_back_to_email(self, env):
        env.login(SimpleNamespace(username=None, email="a2@example.com"))
        env.client.post(BASE, json=_payload())
        meta, _ = env.body.parse_issue_body(env.fake.calls[1][4])
        assert meta["author"] == "a2@example.com"

    def test_comment_terminator_in_values_cannot_break_block(self, env):
        payload = _payload(text="see --> here")
        payload["anchor"]["text_snippet"] = "x --> <!-- y"
        env.client.post(BASE, json=payload)
        body = env.fake.calls[1][4]
        assert body.index("-->") == body.index("\n-->\n") + 1
        meta, text = env.body.parse_issue_body(body)
        assert meta["text_snippet"] == "x --> <!-- y"
        assert text == "see --> here"

    @pytest.mark.parametrize(
        "overrides",
        [
            {"text": "   "},
            {"text": "x" * 4001},
            {"type": "feature"},
            {"anchor": {"url": "https://example.com", "css_path": "main"}},
        ],
    )
    def test_rejects_invalid_body(self, env, overrides):
        response = env.client.post(BASE, json=_payload(**overrides))
        assert response.status_code == 422
        assert env.fake.calls == []

    def test_rejects_long_snippet_and_bad_input(self, env):
        payload = _payload()
        payload["anchor"]["text_snippet"] = "s" * 201
        assert env.client.post(BASE, json=payload).status_code == 422
        payload = _payload()
        payload["context"]["input"] = "pen"
        assert env.client.post(BASE, json=payload).status_code == 422

    def test_github_error_gives_502(self, env):
        env.fake.fail = env.gh.GitHubError("GitHub returned 500", status_code=500)
        response = env.client.post(BASE, json=_payload())
        assert response.status_code == 502
        assert "GitHub" in response.json()["detail"]


class TestList:
    def test_parses_items_and_maps_status_and_type(self, env):
        older = env.fake.add(_meta(), "older note", created=NOW - timedelta(days=2))
        working = env.fake.add(
            _meta(),
            "being fixed",
            labels=["annotation", "ann-type:design", "ann:working"],
            created=NOW - timedelta(days=1),
        )
        response = env.client.get(BASE)
        assert response.status_code == 200
        items = response.json()["items"]
        assert [i["number"] for i in items] == [working["number"], older["number"]]
        first = items[0]
        assert first["status"] == "working"
        assert first["type"] == "design"
        assert first["text"] == "being fixed"
        assert first["author"] == "someone"
        assert first["html_url"] == working["html_url"]
        assert first["anchor"] == {
            "path": "/c/8f2e41",
            "url": "https://example.com/c/8f2e41",
            "ann_id": "hero-text",
            "css_path": "main > p",
            "text_snippet": None,
            "ancestor_snippets": None,
            "rect": None,
            "drawing": None,
        }
        assert items[1]["status"] == "open"
        assert items[1]["type"] == "bug"
        assert set(first) == {
            "number",
            "html_url",
            "title",
            "text",
            "type",
            "status",
            "anchor",
            "created_at",
            "updated_at",
            "closed_at",
            "author",
        }
        assert first["closed_at"] is None

    def test_filters_by_path(self, env):
        env.fake.add(_meta("/c/a"), "on a")
        env.fake.add(_meta("/c/b"), "on b")
        items = env.client.get(BASE, params={"path": "/c/b"}).json()["items"]
        assert [i["text"] for i in items] == ["on b"]

    def test_skips_missing_and_malformed_blocks(self, env):
        good = env.fake.add(_meta(), "good")
        env.fake.add(None, body="Plain issue with no block")
        env.fake.add(None, body="<!-- ann:v1\n{not json\n-->\n**Note**\n\nx")
        env.fake.add(None, body='<!-- ann:v1\n["a list"]\n-->\n**Note**\n\nx')
        env.fake.add(None, body='<!-- ann:v1\n{"url":"no path"}\n-->\nx')
        env.fake.add(None, body=None)
        pr = env.fake.add(_meta(), "pull request")
        pr["pull_request"] = {"url": "x"}
        response = env.client.get(BASE)
        assert response.status_code == 200
        assert [i["number"] for i in response.json()["items"]] == [good["number"]]

    def test_state_all_adds_recently_closed_only(self, env):
        opened = env.fake.add(_meta(), "open one")
        recent = env.fake.add(
            _meta(), "recent", state="closed", closed=NOW - timedelta(days=1)
        )
        env.fake.add(_meta(), "old", state="closed", closed=NOW - timedelta(days=8))

        default = env.client.get(BASE).json()["items"]
        assert [i["number"] for i in default] == [opened["number"]]

        items = env.client.get(BASE, params={"state": "all"}).json()["items"]
        numbers = {i["number"]: i["status"] for i in items}
        assert numbers == {opened["number"]: "open", recent["number"]: "done"}
        closed_at = {i["number"]: i["closed_at"] for i in items}
        assert closed_at == {
            opened["number"]: None,
            recent["number"]: recent["closed_at"],
        }
        closed_call = [c for c in env.fake.calls if c[0] == "list_issues"][-1]
        assert closed_call[2] == "closed"
        assert closed_call[3] is not None

    def test_rejects_unknown_state(self, env):
        assert env.client.get(BASE, params={"state": "closed"}).status_code == 422

    def test_caches_for_30_seconds_and_post_invalidates(self, env):
        env.fake.add(_meta(), "first")
        env.client.get(BASE)
        env.client.get(BASE, params={"path": "/other"})
        assert env.fake.names().count("list_issues") == 1

        env.client.post(BASE, json=_payload())
        items = env.client.get(BASE).json()["items"]
        assert env.fake.names().count("list_issues") == 2
        assert len(items) == 2

        clock = [1000.0]
        env.monkeypatch.setattr(env.routes.time, "monotonic", lambda: clock[0])
        env.routes.invalidate_list_cache()
        env.client.get(BASE)
        clock[0] += 29
        env.client.get(BASE)
        assert env.fake.names().count("list_issues") == 3
        clock[0] += 2
        env.client.get(BASE)
        assert env.fake.names().count("list_issues") == 4

    def test_invalidation_during_fetch_is_not_overwritten(self, env):
        env.fake.add(_meta(), "first")
        real_list = env.fake.list_issues
        state = {"invalidated": False}

        async def list_then_write(token, repo, issue_state, since=None):
            result = await real_list(token, repo, issue_state, since)
            if not state["invalidated"]:
                state["invalidated"] = True
                env.routes.invalidate_list_cache()
            return result

        env.monkeypatch.setattr(env.gh, "list_issues", list_then_write)
        env.client.get(BASE)
        assert env.fake.names().count("list_issues") == 1
        env.client.get(BASE)
        assert env.fake.names().count("list_issues") == 2
        env.client.get(BASE)
        assert env.fake.names().count("list_issues") == 2

    def test_fresh_skips_cache_and_refreshes_it(self, env):
        env.fake.add(_meta(), "first")
        assert len(env.client.get(BASE).json()["items"]) == 1
        # A write served by another replica: GitHub changes, this cache doesn't.
        env.fake.add(_meta(), "second")
        assert len(env.client.get(BASE).json()["items"]) == 1
        assert env.fake.names().count("list_issues") == 1

        fresh = env.client.get(BASE, params={"fresh": "1"}).json()["items"]
        assert len(fresh) == 2
        assert env.fake.names().count("list_issues") == 2
        assert len(env.client.get(BASE).json()["items"]) == 2
        assert env.fake.names().count("list_issues") == 2

    def test_github_error_gives_502(self, env):
        env.fake.fail = env.gh.GitHubError("GitHub request timed out")
        response = env.client.get(BASE)
        assert response.status_code == 502
        assert response.json()["detail"] == "GitHub request timed out"


class TestStatus:
    def test_done_closes_and_open_reopens(self, env):
        issue = env.fake.add(_meta(), "fix me")
        number = issue["number"]

        response = env.client.post(f"{BASE}/{number}/status", json={"status": "done"})
        assert response.status_code == 200
        assert response.json()["status"] == "done"
        assert response.json()["number"] == number
        assert response.json()["closed_at"] == env.fake.issues[number]["closed_at"]
        assert response.json()["closed_at"] is not None
        assert ("set_issue_state", REPO, number, "closed") in env.fake.calls

        response = env.client.post(f"{BASE}/{number}/status", json={"status": "open"})
        assert response.status_code == 200
        assert response.json()["status"] == "open"
        assert response.json()["closed_at"] is None
        assert ("set_issue_state", REPO, number, "open") in env.fake.calls

    def test_done_leaves_labels_alone(self, env):
        issue = env.fake.add(
            _meta(), "x", labels=["annotation", "ann-type:bug", "ann:working"]
        )
        env.client.post(f"{BASE}/{issue['number']}/status", json={"status": "done"})
        assert "remove_label" not in env.fake.names()

    def test_reopen_drops_working_label(self, env):
        issue = env.fake.add(
            _meta(),
            "x",
            state="closed",
            closed=NOW,
            labels=["annotation", "ann-type:bug", "ann:working"],
        )
        number = issue["number"]
        response = env.client.post(f"{BASE}/{number}/status", json={"status": "open"})
        assert response.status_code == 200
        assert response.json()["status"] == "open"
        assert ("remove_label", REPO, number, "ann:working") in env.fake.calls
        names = [lb["name"] for lb in env.fake.issues[number]["labels"]]
        assert names == ["annotation", "ann-type:bug"]
        assert env.client.get(BASE).json()["items"][0]["status"] == "open"

    def _working_closed(self, env):
        return env.fake.add(
            _meta(),
            "x",
            state="closed",
            closed=NOW,
            labels=["annotation", "ann-type:bug", "ann:working"],
        )

    def test_reopen_removes_working_label_before_reopening(self, env):
        number = self._working_closed(env)["number"]
        env.client.post(f"{BASE}/{number}/status", json={"status": "open"})
        status_calls = [
            c[0] for c in env.fake.calls if c[0] in ("remove_label", "set_issue_state")
        ]
        assert status_calls == ["remove_label", "set_issue_state"]

    def test_reopen_without_working_label_skips_removal(self, env):
        issue = env.fake.add(_meta(), "x", state="closed", closed=NOW)
        response = env.client.post(
            f"{BASE}/{issue['number']}/status", json={"status": "open"}
        )
        assert response.status_code == 200
        assert response.json()["status"] == "open"
        assert "remove_label" not in env.fake.names()

    def test_failed_label_removal_gives_502_and_leaves_issue_unchanged(self, env):
        number = self._working_closed(env)["number"]
        env.client.get(BASE, params={"state": "all"})
        lists_before = env.fake.names().count("list_issues")

        async def failing(*_args):
            raise env.gh.GitHubError("GitHub returned 500", status_code=500)

        env.monkeypatch.setattr(env.gh, "remove_label", failing)
        response = env.client.post(f"{BASE}/{number}/status", json={"status": "open"})
        assert response.status_code == 502
        assert "set_issue_state" not in env.fake.names()
        issue = env.fake.issues[number]
        assert issue["state"] == "closed"
        assert "ann:working" in [lb["name"] for lb in issue["labels"]]
        # The cache is cleared however the request ends.
        env.client.get(BASE, params={"state": "all"})
        assert env.fake.names().count("list_issues") > lists_before

    def test_failed_reopen_after_label_removal_gives_502(self, env):
        number = self._working_closed(env)["number"]

        async def failing(*_args):
            raise env.gh.GitHubError("GitHub returned 500", status_code=500)

        env.monkeypatch.setattr(env.gh, "set_issue_state", failing)
        response = env.client.post(f"{BASE}/{number}/status", json={"status": "open"})
        assert response.status_code == 502
        assert ("remove_label", REPO, number, "ann:working") in env.fake.calls
        assert env.fake.issues[number]["state"] == "closed"

    def test_status_change_invalidates_list_cache(self, env):
        issue = env.fake.add(_meta(), "fix me")
        assert len(env.client.get(BASE).json()["items"]) == 1
        env.client.post(f"{BASE}/{issue['number']}/status", json={"status": "done"})
        assert env.client.get(BASE).json()["items"] == []

    def test_rejects_unknown_status(self, env):
        issue = env.fake.add(_meta(), "x")
        response = env.client.post(
            f"{BASE}/{issue['number']}/status", json={"status": "working"}
        )
        assert response.status_code == 422

    def test_missing_issue_gives_404(self, env):
        response = env.client.post(f"{BASE}/999/status", json={"status": "done"})
        assert response.status_code == 404
        assert "set_issue_state" not in env.fake.names()

    def test_refuses_issue_that_is_not_an_annotation(self, env):
        issue = env.fake.add(_meta(), "x", labels=["bug"])
        response = env.client.post(
            f"{BASE}/{issue['number']}/status", json={"status": "done"}
        )
        assert response.status_code == 404
        assert "set_issue_state" not in env.fake.names()

    def test_github_error_gives_502(self, env):
        issue = env.fake.add(_meta(), "x")
        env.fake.fail = env.gh.GitHubError("GitHub returned 500", status_code=500)
        response = env.client.post(
            f"{BASE}/{issue['number']}/status", json={"status": "done"}
        )
        assert response.status_code == 502


class TestBodyFormat:
    def test_round_trips_and_handles_crlf(self):
        from fixfast_github import issue_body as gh

        meta = _meta(css_path="a | b", text_snippet="q`x")
        body = gh.build_issue_body(meta, "line one\n\nline two")
        assert "`a \\| b`" in body
        parsed = gh.parse_issue_body(body.replace("\n", "\r\n"))
        assert parsed is not None
        assert parsed[0] == meta
        assert parsed[1] == "line one\n\nline two"

    def test_hand_edited_body_without_table_keeps_text(self):
        from fixfast_github import issue_body as gh

        block = json.dumps({"path": "/"})
        parsed = gh.parse_issue_body(f"<!-- ann:v1 {block} -->\nJust words")
        assert parsed == ({"path": "/"}, "Just words")


class TestGitHubClient:
    """The HTTP helpers against an httpx MockTransport."""

    @pytest.fixture()
    def transport(self, monkeypatch):
        from fixfast_github import github_client as gh

        seen: List[httpx.Request] = []
        responses: List[Any] = []
        real_client = httpx.AsyncClient

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            result = responses.pop(0)
            if isinstance(result, Exception):
                raise result
            return result

        def client(**kwargs):
            assert kwargs["timeout"] == 10.0
            return real_client(transport=httpx.MockTransport(handler), **kwargs)

        monkeypatch.setattr(gh.httpx, "AsyncClient", client)
        monkeypatch.setattr(gh, "_ensured_labels", set())
        return SimpleNamespace(gh=gh, seen=seen, responses=responses)

    @pytest.mark.asyncio
    async def test_create_issue_sends_headers_and_payload(self, transport):
        transport.responses.append(httpx.Response(201, json={"number": 7}))
        result = await transport.gh.create_issue("tok", "o/r", "t", "b", ["annotation"])
        assert result == {"number": 7}
        request = transport.seen[0]
        assert request.method == "POST"
        assert str(request.url) == "https://api.github.com/repos/o/r/issues"
        assert request.headers["Authorization"] == "Bearer tok"
        assert request.headers["Accept"] == "application/vnd.github+json"
        assert request.headers["X-GitHub-Api-Version"] == "2022-11-28"
        assert json.loads(request.content) == {
            "title": "t",
            "body": "b",
            "labels": ["annotation"],
        }

    @pytest.mark.asyncio
    async def test_list_issues_query(self, transport):
        transport.responses.append(httpx.Response(200, json=[]))
        await transport.gh.list_issues(
            "tok", "o/r", "closed", since="2026-01-01T00:00:00Z"
        )
        params = transport.seen[0].url.params
        assert params["labels"] == "annotation"
        assert params["state"] == "closed"
        assert params["per_page"] == "100"
        assert params["sort"] == "created"
        assert params["direction"] == "desc"
        assert params["since"] == "2026-01-01T00:00:00Z"

    @pytest.mark.asyncio
    async def test_errors_become_github_error(self, transport):
        gh = transport.gh
        transport.responses.append(httpx.Response(500, json={}))
        with pytest.raises(gh.GitHubError) as info:
            await gh.get_issue("tok", "o/r", 1)
        assert info.value.status_code == 500

        transport.responses.append(httpx.ReadTimeout("slow"))
        with pytest.raises(gh.GitHubError, match="timed out"):
            await gh.get_issue("tok", "o/r", 1)

        transport.responses.append(httpx.ConnectError("down"))
        with pytest.raises(gh.GitHubError):
            await gh.set_issue_state("tok", "o/r", 1, "closed")

    @pytest.mark.asyncio
    async def test_ensure_labels_is_best_effort_and_remembers(self, transport):
        gh = transport.gh
        transport.responses.extend(
            [
                httpx.Response(201, json={}),
                httpx.Response(422, json={"message": "already_exists"}),
                httpx.Response(403, json={}),
            ]
        )
        await gh.ensure_labels("tok", "o/r", ["annotation", "ann-type:bug", "x"])
        assert len(transport.seen) == 3
        assert gh._ensured_labels == {("o/r", "annotation"), ("o/r", "ann-type:bug")}

        transport.responses.append(httpx.Response(201, json={}))
        await gh.ensure_labels("tok", "o/r", ["annotation", "ann-type:bug", "x"])
        assert len(transport.seen) == 4
        assert json.loads(transport.seen[-1].content)["name"] == "x"

    @pytest.mark.asyncio
    async def test_remove_label_ignores_404_only(self, transport):
        gh = transport.gh
        transport.responses.append(httpx.Response(404, json={}))
        await gh.remove_label("tok", "o/r", 5, "ann:working")
        request = transport.seen[0]
        assert request.method == "DELETE"
        assert request.url.raw_path == b"/repos/o/r/issues/5/labels/ann%3Aworking"

        transport.responses.append(httpx.Response(500, json={}))
        with pytest.raises(gh.GitHubError):
            await gh.remove_label("tok", "o/r", 5, "ann:working")

    @pytest.mark.asyncio
    async def test_list_issues_combines_pages(self, transport):
        next_url = "https://api.github.com/repositories/1/issues?state=open&page=2"
        transport.responses.extend(
            [
                httpx.Response(
                    200,
                    json=[{"number": 2}, {"number": 1}],
                    headers={
                        "Link": f'<{next_url}>; rel="next", <{next_url}>; rel="last"'
                    },
                ),
                httpx.Response(200, json=[{"number": 0}]),
            ]
        )
        result = await transport.gh.list_issues("tok", "o/r", "open")
        assert [i["number"] for i in result] == [2, 1, 0]
        assert len(transport.seen) == 2
        assert str(transport.seen[1].url) == next_url
        assert transport.seen[1].headers["Authorization"] == "Bearer tok"

    @pytest.mark.asyncio
    async def test_list_issues_stops_after_five_pages_and_warns(
        self, transport, caplog
    ):
        next_url = "https://api.github.com/repositories/1/issues?page=next"
        for n in range(6):
            transport.responses.append(
                httpx.Response(
                    200,
                    json=[{"number": n}],
                    headers={"Link": f'<{next_url}>; rel="next"'},
                )
            )
        result = await transport.gh.list_issues("tok", "o/r", "open")
        assert [i["number"] for i in result] == [0, 1, 2, 3, 4]
        assert len(transport.seen) == 5
        assert "Warning: more than 500 open annotation issues" in caplog.text

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "next_url",
        [
            "https://evil.example.com/repos/o/r/issues?page=2",
            "http://api.github.com/repos/o/r/issues?page=2",
        ],
    )
    async def test_list_issues_ignores_next_link_off_github(
        self, transport, caplog, next_url
    ):
        transport.responses.append(
            httpx.Response(
                200,
                json=[{"number": 1}],
                headers={"Link": f'<{next_url}>; rel="next"'},
            )
        )
        result = await transport.gh.list_issues("tok", "o/r", "open")
        assert [i["number"] for i in result] == [1]
        assert len(transport.seen) == 1
        assert "not following next-page link" in caplog.text


def _drawing(strokes: Optional[List[Any]] = None) -> Dict[str, Any]:
    return {
        "strokes": strokes if strokes is not None else [[[0.1, 0.2], [0.9, 0.8]]],
        "bbox": {"x": 10, "y": 20, "w": 100, "h": 50},
    }


def _marked_payload(**anchor: Any) -> Dict[str, Any]:
    payload = _payload()
    payload["anchor"].update(anchor)
    return payload


class TestDrawingAndPickContext:
    def test_stores_rect_drawing_and_scroll_rounded(self, env):
        payload = _marked_payload(
            rect={"x": 12.34567, "y": -3.0001, "w": 200.5, "h": 40},
            drawing={
                "strokes": [
                    [[0.12351, -0.0004], [1.5, 9.9999]],
                    [[-10, 10]],
                ],
                "bbox": {"x": 1.23456, "y": 2, "w": 3.33333, "h": 0},
            },
        )
        payload["context"]["scroll"] = {"x": 0, "y": 1234.5678}
        assert env.client.post(BASE, json=payload).status_code == 201

        meta, _ = env.body.parse_issue_body(env.fake.calls[1][4])
        assert meta["rect"] == {"x": 12.346, "y": -3.0, "w": 200.5, "h": 40.0}
        assert meta["drawing"] == {
            "strokes": [[[0.124, 0.0], [1.5, 10.0]], [[-10.0, 10.0]]],
            "bbox": {"x": 1.235, "y": 2.0, "w": 3.333, "h": 0.0},
        }
        assert meta["scroll"] == {"x": 0.0, "y": 1234.568}
        assert "-0.0" not in env.fake.calls[1][4]

        anchor = env.client.get(BASE).json()["items"][0]["anchor"]
        assert anchor["rect"] == meta["rect"]
        assert anchor["drawing"] == meta["drawing"]

    def test_marked_row_counts_strokes_only_when_drawn(self, env):
        env.client.post(BASE, json=_payload())
        assert "| Marked |" not in env.fake.calls[-1][4]

        env.client.post(BASE, json=_marked_payload(drawing=_drawing()))
        assert "| Marked | 1 stroke |" in env.fake.calls[-1][4]

        strokes = [[[0.1, 0.1]], [[0.2, 0.2]], [[0.3, 0.3]]]
        env.client.post(BASE, json=_marked_payload(drawing=_drawing(strokes)))
        assert "| Marked | 3 strokes |" in env.fake.calls[-1][4]

    @pytest.mark.parametrize(
        ("dpr", "shown"),
        [(1, "@1x"), (2, "@2x"), (2.625, "@2.625x"), (1.33333, "@1.333x")],
    )
    def test_device_row_shows_dpr(self, env, dpr, shown):
        payload = _payload()
        payload["context"]["viewport"]["dpr"] = dpr
        payload["context"]["input"] = "pointer"
        env.client.post(BASE, json=payload)
        assert f"| Device | 390×844 {shown} · pointer |" in env.fake.calls[-1][4]

    @pytest.mark.parametrize(
        "drawing",
        [
            _drawing([]),
            _drawing([[[0, 0]]] * 31),
            _drawing([[]]),
            _drawing([[[0, 0]] * 401]),
            _drawing([[[0, 0]] * 376] * 4),
            _drawing([[[0, 10.001]]]),
            _drawing([[[-10.5, 0]]]),
            _drawing([[[0, 0, 0]]]),
            _drawing([[[0]]]),
            _drawing([[["a", 0]]]),
            {"strokes": [[[0, 0]]]},
            {"strokes": [[[0, 0]]], "bbox": {"x": 0, "y": 0, "w": -1, "h": 1}},
        ],
    )
    def test_rejects_drawing_outside_limits(self, env, drawing):
        response = env.client.post(BASE, json=_marked_payload(drawing=drawing))
        assert response.status_code == 422
        assert env.fake.calls == []

    def test_accepts_drawing_at_limits(self, env):
        strokes = [[[10, -10]] * 400] * 3 + [[[0, 0]] * 300]
        response = env.client.post(
            BASE, json=_marked_payload(drawing=_drawing(strokes))
        )
        assert response.status_code == 201
        strokes = [[[0.5, 0.5]] * 50] * 30
        response = env.client.post(
            BASE, json=_marked_payload(drawing=_drawing(strokes))
        )
        assert response.status_code == 201

    @pytest.mark.parametrize(
        ("where", "value"),
        [
            ("rect", '{"x": NaN, "y": 0, "w": 1, "h": 1}'),
            ("rect", '{"x": 0, "y": Infinity, "w": 1, "h": 1}'),
            ("rect", '{"x": 0, "y": 0, "w": -0.5, "h": 1}'),
            ("rect", '{"x": 0, "y": 0, "w": 1}'),
            ("drawing", '{"strokes": [[[NaN, 0]]], "bbox": {"x":0,"y":0,"w":0,"h":0}}'),
            ("scroll", '{"x": -Infinity, "y": 0}'),
            ("scroll", '{"x": "far", "y": 0}'),
            ("viewport", '{"w": NaN, "h": 844, "dpr": 3}'),
            ("viewport", '{"w": 390, "h": 844, "dpr": Infinity}'),
        ],
    )
    def test_rejects_non_finite_or_malformed_numbers(self, env, where, value):
        payload = _payload()
        in_context = where in ("scroll", "viewport")
        target = payload["context"] if in_context else payload["anchor"]
        target[where] = "__VALUE__"
        raw = json.dumps(payload).replace('"__VALUE__"', value)
        response = env.client.post(
            BASE, content=raw, headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 422
        assert env.fake.calls == []

    def test_stores_and_returns_ancestor_snippets(self, env):
        snippets = ["  Pricing plans  ", "Pricing"]
        response = env.client.post(
            BASE, json=_marked_payload(ancestor_snippets=snippets)
        )
        assert response.status_code == 201
        body = env.fake.calls[1][4]
        meta, _ = env.body.parse_issue_body(body)
        assert meta["ancestor_snippets"] == ["Pricing plans", "Pricing"]
        table = body[body.index("| | |") :]
        assert "Pricing plans" not in table
        anchor = env.client.get(BASE).json()["items"][0]["anchor"]
        assert anchor["ancestor_snippets"] == ["Pricing plans", "Pricing"]

    def test_accepts_empty_and_six_ancestor_snippets(self, env):
        for snippets in ([], ["s" * 200] * 6):
            response = env.client.post(
                BASE, json=_marked_payload(ancestor_snippets=snippets)
            )
            assert response.status_code == 201

    @pytest.mark.parametrize(
        "snippets",
        [["x"] * 7, [""], ["   "], ["s" * 201], [3], "not a list", [None]],
    )
    def test_rejects_bad_ancestor_snippets(self, env, snippets):
        response = env.client.post(
            BASE, json=_marked_payload(ancestor_snippets=snippets)
        )
        assert response.status_code == 422
        assert env.fake.calls == []

    @pytest.mark.parametrize(
        "stored", [["ok", ""], ["x"] * 7, "text", [{"a": 1}], ["s" * 201]]
    )
    def test_hand_edited_bad_ancestor_snippets_become_null(self, env, stored):
        env.fake.add(_meta(ancestor_snippets=stored), "edited")
        items = env.client.get(BASE).json()["items"]
        assert [i["text"] for i in items] == ["edited"]
        assert items[0]["anchor"]["ancestor_snippets"] is None

    def test_hand_edited_bad_drawing_keeps_the_note(self, env):
        env.fake.add(
            _meta(rect={"x": "?"}, drawing={"strokes": [[[99, 0]]], "bbox": {}}),
            "edited",
        )
        items = env.client.get(BASE).json()["items"]
        assert [i["text"] for i in items] == ["edited"]
        assert items[0]["anchor"]["rect"] is None
        assert items[0]["anchor"]["drawing"] is None


def _max_payload(char: str) -> Dict[str, Any]:
    """Every string at its length limit, filled with ``char``, plus the
    largest drawing allowed with the longest coordinate text."""
    fill = lambda n: char * n  # noqa: E731
    return {
        "text": fill(4000),
        "type": "question",
        "anchor": {
            "path": fill(2048),
            "url": fill(4096),
            "ann_id": fill(200),
            "css_path": fill(2000),
            "text_snippet": fill(200),
            "ancestor_snippets": [fill(200)] * 6,
            "rect": {"x": -12345.678, "y": -12345.678, "w": 12345.678, "h": 12345.678},
            "drawing": {
                "strokes": [[[-9.999, -9.999]] * 400] * 3 + [[[-9.999, -9.999]] * 300],
                "bbox": {"x": -9.999, "y": -9.999, "w": 9.999, "h": 9.999},
            },
        },
        "context": {
            "viewport": {"w": 100_000, "h": 100_000, "dpr": 19.999},
            "input": "pointer",
            "env": fill(32),
            "build_sha": fill(64),
            "theme": fill(32),
            "lang": fill(16),
            "ua": fill(1000),
            "scroll": {"x": -123456.789, "y": -123456.789},
        },
    }


class TestBodySize:
    def test_largest_plain_note_with_largest_drawing_fits_with_room(self, env):
        response = env.client.post(BASE, json=_max_payload("w"))
        assert response.status_code == 201
        body = env.fake.calls[-1][4]
        assert len(body) < 50_000
        assert len(body) < env.body.MAX_BODY_CHARS < 65_536
        meta, _ = env.body.parse_issue_body(body)
        assert sum(len(s) for s in meta["drawing"]["strokes"]) == 1500
        assert meta["ancestor_snippets"] == ["w" * 200] * 6

    def test_body_over_the_cap_is_refused_before_github(self, env):
        # "<" is stored as the six characters <, so this body is far
        # longer than the plain one.
        response = env.client.post(BASE, json=_max_payload("<"))
        assert response.status_code == 422
        assert response.json()["detail"] == "annotation_too_large"
        assert env.fake.calls == []


class TestStandalone:
    """create_router with host callbacks of the test's own, no app imports."""

    @pytest.fixture()
    def standalone(self, monkeypatch):
        from fastapi import Header, HTTPException

        import fixfast_github
        from fixfast_github import AnnotateSettings, create_router, issue_body
        from fixfast_github import github_app_auth as auth
        from fixfast_github import github_client as gh

        fixfast_github.reset_caches()
        fake = FakeGitHub(gh, issue_body)
        for name in (
            "create_issue",
            "get_issue",
            "list_issues",
            "set_issue_state",
            "remove_label",
            "ensure_labels",
        ):
            monkeypatch.setattr(gh, name, getattr(fake, name))

        async def token(settings):
            return f"token-for-{settings.repo}"

        monkeypatch.setattr(auth, "installation_token", token)

        def require_admin(x_admin: Optional[str] = Header(None)):
            if x_admin is None:
                raise HTTPException(status_code=403, detail="admins only")
            return {"name": x_admin}

        settings_calls: List[str] = []
        repos = {"a": "acme/notes-a", "b": "acme/notes-b"}

        def settings_for(key):
            def read():
                settings_calls.append(key)
                return AnnotateSettings(
                    app_id=1, private_key="k", installation_id=None, repo=repos[key]
                )

            return read

        app = FastAPI()
        for key in repos:
            app.include_router(
                create_router(
                    require_admin=require_admin,
                    author_of=lambda admin: f"@{admin['name']}",
                    settings=settings_for(key),
                    prefix=f"/notes-{key}",
                )
            )
        yield SimpleNamespace(
            client=TestClient(app),
            fake=fake,
            body=issue_body,
            settings_calls=settings_calls,
            repos=repos,
            monkeypatch=monkeypatch,
            AnnotateSettings=AnnotateSettings,
        )
        fixfast_github.reset_caches()

    def test_uses_host_admin_author_and_settings(self, standalone):
        client = standalone.client
        assert client.get("/notes-a").status_code == 403
        assert standalone.fake.calls == []

        response = client.post(
            "/notes-a", json=_payload(), headers={"X-Admin": "alice"}
        )
        assert response.status_code == 201
        _, token, repo, _, body, _ = standalone.fake.calls[-1]
        assert (token, repo) == ("token-for-acme/notes-a", "acme/notes-a")
        meta, _ = standalone.body.parse_issue_body(body)
        assert meta["author"] == "@alice"
        assert standalone.settings_calls == ["a"]

    def test_routers_with_different_repos_keep_separate_caches(self, standalone):
        client = standalone.client
        headers = {"X-Admin": "alice"}
        # The fake's issues are shared, so a cache keyed only by state would
        # return router a's list to router b without a second fetch.
        standalone.fake.add(_meta(), "only one")
        assert len(client.get("/notes-a", headers=headers).json()["items"]) == 1
        client.get("/notes-b", headers=headers)
        listed = [c[1] for c in standalone.fake.calls if c[0] == "list_issues"]
        assert listed == ["acme/notes-a", "acme/notes-b"]

        # A write through b leaves a's cached list alone.
        client.post("/notes-b", json=_payload(), headers=headers)
        client.get("/notes-a", headers=headers)
        client.get("/notes-b", headers=headers)
        listed = [c[1] for c in standalone.fake.calls if c[0] == "list_issues"]
        assert listed == ["acme/notes-a", "acme/notes-b", "acme/notes-b"]

    def test_settings_are_read_per_request(self, standalone):
        client = standalone.client
        standalone.repos["a"] = "acme/moved"
        client.post("/notes-a", json=_payload(), headers={"X-Admin": "alice"})
        assert standalone.fake.calls[-1][2] == "acme/moved"

    def test_unconfigured_settings_give_503(self, standalone):
        from fixfast_github import router as ann_router

        standalone.monkeypatch.setattr(
            ann_router.github_app_auth,
            "installation_token",
            lambda s: pytest.fail("token requested without settings"),
        )
        unconfigured = standalone.AnnotateSettings(
            app_id="", private_key="", repo="acme/x"
        )
        app = FastAPI()
        from fixfast_github import create_router

        app.include_router(
            create_router(
                require_admin=lambda: "admin",
                author_of=str,
                settings=lambda: unconfigured,
            )
        )
        response = TestClient(app).get(BASE)
        assert response.status_code == 503
        assert response.json()["detail"] == "annotations_not_configured"

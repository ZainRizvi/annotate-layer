"""Runnable example: ``uvicorn example_app:app --reload``.

Settings come from GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
GITHUB_APP_INSTALLATION_ID (optional) and ANNOTATIONS_REPO (``owner/name``).
"""

import os
import secrets

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from fixthis_github import AnnotateSettings, create_router


def require_admin(authorization: str = Header(default="")) -> str:
    """PLACEHOLDER: replace with your real authentication.

    This compares a bearer token to ADMIN_TOKEN. It must return the signed-in
    admin and raise 401 (not signed in) or 403 (not an admin) otherwise.
    """
    expected = os.environ.get("ADMIN_TOKEN", "")
    token = authorization.removeprefix("Bearer ").strip()
    if not expected or not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="not signed in")
    return "admin"


def settings() -> AnnotateSettings:
    return AnnotateSettings(
        app_id=os.environ.get("GITHUB_APP_ID", ""),
        private_key=os.environ.get("GITHUB_APP_PRIVATE_KEY", ""),
        installation_id=os.environ.get("GITHUB_APP_INSTALLATION_ID"),
        repo=os.environ.get("ANNOTATIONS_REPO", "example/annotations"),
    )


app = FastAPI()

# When the frontend runs on another origin and sends cookies, list that exact
# origin (never "*") and set allow_credentials=True.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(
    create_router(
        require_admin=require_admin,
        author_of=lambda admin: admin,
        settings=settings,
        prefix="/api/admin/annotations",
    )
)

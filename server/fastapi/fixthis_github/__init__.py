"""Annotate: notes pinned to parts of a website, stored as GitHub issues.

A standalone FastAPI package; it imports nothing from the host app. See
``README.md``.
"""

from fixthis_github.router import create_router, reset_caches
from fixthis_github.settings import AnnotateSettings

__all__ = ["AnnotateSettings", "create_router", "reset_caches"]

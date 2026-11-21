"""Settings the host app supplies for each request."""

from dataclasses import dataclass
from typing import Optional, Union


@dataclass(frozen=True, kw_only=True)
class AnnotateSettings:
    """Where notes are stored and how the backend authenticates to GitHub.

    ``app_id`` and ``private_key`` belong to a GitHub App installed on
    ``repo`` (``owner/name``) with Issues read/write. ``private_key`` is the
    App's PEM; literal ``\\n`` sequences are read as newlines.
    ``installation_id`` is looked up from the repo when blank or ``None``.
    """

    app_id: Union[str, int]
    private_key: str
    installation_id: Optional[Union[str, int]] = None
    repo: str

    @property
    def is_configured(self) -> bool:
        app_id = "" if self.app_id is None else str(self.app_id)
        return bool(app_id.strip() and (self.private_key or "").strip())

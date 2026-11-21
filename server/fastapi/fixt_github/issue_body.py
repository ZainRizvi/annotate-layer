"""Issue title and body for an annotation. Pure functions, no I/O.

The body starts with a machine-readable ``<!-- ann:v1 {json} -->`` block,
followed by the note text and a summary table for people reading the issue.
"""

import json
import re
from typing import Any, Dict, List, Optional, Tuple

TITLE_PREFIX = "[ann] "
TITLE_TEXT_CHARS = 70
# GitHub refuses issue bodies over 65,536 characters; bodies longer than this
# are refused before they reach GitHub.
MAX_BODY_CHARS = 60_000

_BLOCK_RE = re.compile(r"<!--\s*ann:v1\s*(.*?)\s*-->", re.DOTALL)
_NOTE_HEADING = "**Note**"
_TABLE_HEADER = "| | |"


def make_title(text: str) -> str:
    collapsed = " ".join(text.split())
    return TITLE_PREFIX + collapsed[:TITLE_TEXT_CHARS]


def _cell(value: str) -> str:
    """Make ``value`` safe inside one markdown table cell."""
    return " ".join(value.split()).replace("|", "\\|")


def _code(value: str) -> str:
    return "`" + _cell(value).replace("`", "'") + "`"


def format_dpr(dpr: Any) -> str:
    """``2`` -> ``"2"``, ``2.625`` -> ``"2.625"`` (at most 3 decimals)."""
    try:
        text = f"{float(dpr):.3f}"
    except (TypeError, ValueError):
        return "?"
    return text.rstrip("0").rstrip(".")


def _device(meta: Dict[str, Any]) -> str:
    """Like ``390×844 @3x · touch``."""
    viewport = meta.get("viewport")
    if not isinstance(viewport, dict):
        viewport = {}
    parts = [f"{viewport.get('w')}×{viewport.get('h')}"]
    if viewport.get("dpr") is not None:
        parts[0] += f" @{format_dpr(viewport.get('dpr'))}x"
    if meta.get("input"):
        parts.append(str(meta["input"]))
    return " · ".join(parts)


def _marked(meta: Dict[str, Any]) -> Optional[str]:
    """``"3 strokes"`` when the anchor has a drawing, else ``None``."""
    drawing = meta.get("drawing")
    strokes = drawing.get("strokes") if isinstance(drawing, dict) else None
    if not isinstance(strokes, list) or not strokes:
        return None
    count = len(strokes)
    return f"{count} stroke" if count == 1 else f"{count} strokes"


def build_issue_body(meta: Dict[str, Any], text: str) -> str:
    """The issue body: ``ann:v1`` block, the note, then a summary table.

    ``<`` and ``>`` in the JSON are written as ``\\u003c``/``\\u003e`` so no
    value can close the HTML comment early; ``json.loads`` reads them back.
    """
    encoded = (
        json.dumps(meta, ensure_ascii=False, separators=(",", ":"))
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
    )
    element = " / ".join(
        _code(v) for v in (meta.get("ann_id"), meta.get("css_path")) if v
    )
    build = " ".join(v for v in (meta.get("env"), meta.get("build_sha")) if v)
    rows: List[Tuple[str, str]] = [
        ("Page", _cell(str(meta.get("url", "")))),
        ("Element", element),
        ("Device", _cell(_device(meta))),
        ("Build", _cell(build)),
    ]
    marked = _marked(meta)
    if marked is not None:
        rows.append(("Marked", marked))
    table = "\n".join(
        [_TABLE_HEADER, "|---|---|", *(f"| {k} | {v} |" for k, v in rows)]
    )
    return f"<!-- ann:v1\n{encoded}\n-->\n{_NOTE_HEADING}\n\n{text}\n\n{table}\n"


def parse_issue_body(body: Optional[str]) -> Optional[Tuple[Dict[str, Any], str]]:
    """``(meta, note_text)`` from an issue body, or ``None`` when the body has
    no ``ann:v1`` block, the block is not a JSON object, or it lacks a string
    ``path``. Bodies edited by hand on GitHub still yield their note text."""
    if not body:
        return None
    body = body.replace("\r\n", "\n")
    match = _BLOCK_RE.search(body)
    if not match:
        return None
    try:
        meta = json.loads(match.group(1))
    except ValueError:
        return None
    if not isinstance(meta, dict) or not isinstance(meta.get("path"), str):
        return None

    rest = body[match.end() :].strip()
    if rest.startswith(_NOTE_HEADING):
        rest = rest[len(_NOTE_HEADING) :]
    head, sep, _ = rest.rpartition(f"\n{_TABLE_HEADER}\n")
    text = head if sep else rest
    return meta, text.strip()

"""Request and response bodies of the annotations API."""

import math
from typing import Annotated, Any, Dict, List, Literal, Optional, Tuple

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    Field,
    RootModel,
    StringConstraints,
    model_validator,
)

AnnotationType = Literal["bug", "design", "content", "question"]
AnnotationStatus = Literal["open", "working", "done"]
ListState = Literal["open", "all"]

MAX_STROKES = 30
MAX_POINTS_PER_STROKE = 400
MAX_POINTS_TOTAL = 1500
# Stroke points are relative to the anchor element's rect: 0..1 is inside it.
STROKE_COORD_LIMIT = 10.0


def _text(max_length: int, min_length: int = 0) -> StringConstraints:
    return StringConstraints(
        strip_whitespace=True, min_length=min_length, max_length=max_length
    )


def _non_finite_as_text(value: Any) -> Any:
    """Pass NaN and infinities on as text so validation rejects them.

    The 422 response echoes the rejected input, and a float NaN or infinity
    in it cannot be written as JSON; their text form can."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    return value


Finite = BeforeValidator(_non_finite_as_text)


def _round3(value: float) -> float:
    # ``+ 0.0`` turns ``-0.0`` into ``0.0``.
    return round(value, 3) + 0.0


NoteText = Annotated[str, _text(4000, 1)]
PagePath = Annotated[str, _text(2048, 1)]
PageUrl = Annotated[str, _text(4096, 1)]
CssPath = Annotated[str, _text(2000, 1)]
Name200 = Annotated[str, _text(200)]
# Kept verbatim: the client matches it against page text to re-find the element.
Snippet = Annotated[str, StringConstraints(max_length=200)]
Short64 = Annotated[str, _text(64)]
Short32 = Annotated[str, _text(32)]
Short16 = Annotated[str, _text(16)]
UserAgent = Annotated[str, _text(1000)]
AncestorSnippet = Annotated[str, _text(200, 1)]
MAX_ANCESTOR_SNIPPETS = 6

# ``Finite`` comes last so it runs before the constraints to its left.
Number = Annotated[float, Field(allow_inf_nan=False), AfterValidator(_round3), Finite]
Size = Annotated[
    float, Field(ge=0, allow_inf_nan=False), AfterValidator(_round3), Finite
]
StrokeCoord = Annotated[
    float,
    Field(ge=-STROKE_COORD_LIMIT, le=STROKE_COORD_LIMIT, allow_inf_nan=False),
    AfterValidator(_round3),
    Finite,
]
Point = Tuple[StrokeCoord, StrokeCoord]
Stroke = Annotated[List[Point], Field(min_length=1, max_length=MAX_POINTS_PER_STROKE)]


class AncestorSnippets(RootModel[List[AncestorSnippet]]):
    """``anchor.ancestor_snippets``, for re-validating a stored value."""

    root: Annotated[List[AncestorSnippet], Field(max_length=MAX_ANCESTOR_SNIPPETS)]


class Rect(BaseModel):
    """A box in CSS px, rounded to 3 decimals."""

    x: Number
    y: Number
    w: Size
    h: Size


class Drawing(BaseModel):
    """Pen strokes, each a list of ``[x, y]`` points relative to the anchor
    element's rect at pick time, rounded to 3 decimals."""

    strokes: Annotated[List[Stroke], Field(min_length=1, max_length=MAX_STROKES)]
    bbox: Rect

    @model_validator(mode="after")
    def _total_points(self) -> "Drawing":
        total = sum(len(stroke) for stroke in self.strokes)
        if total > MAX_POINTS_TOTAL:
            raise ValueError(
                f"drawing has {total} points; at most {MAX_POINTS_TOTAL} are allowed"
            )
        return self


class Anchor(BaseModel):
    path: PagePath
    url: PageUrl
    ann_id: Optional[Name200] = None
    css_path: CssPath
    text_snippet: Optional[Snippet] = None
    # Text snippets of the element's [data-ann] ancestors, innermost first;
    # they tell identical repeated rows apart.
    ancestor_snippets: Optional[
        Annotated[List[AncestorSnippet], Field(max_length=MAX_ANCESTOR_SNIPPETS)]
    ] = None
    rect: Optional[Rect] = None
    drawing: Optional[Drawing] = None


class Viewport(BaseModel):
    w: Annotated[int, Field(ge=0, le=100_000), Finite]
    h: Annotated[int, Field(ge=0, le=100_000), Finite]
    dpr: Annotated[float, Field(gt=0, le=20, allow_inf_nan=False), Finite]


class Scroll(BaseModel):
    x: Number
    y: Number


class AnnotationContext(BaseModel):
    viewport: Viewport
    input: Literal["touch", "pointer"]
    env: Short32
    build_sha: Optional[Short64] = None
    theme: Optional[Short32] = None
    lang: Optional[Short16] = None
    ua: Optional[UserAgent] = None
    scroll: Optional[Scroll] = None


class CreateAnnotationRequest(BaseModel):
    text: NoteText
    type: AnnotationType
    anchor: Anchor
    context: AnnotationContext


class CreateAnnotationResponse(BaseModel):
    number: int
    html_url: str
    status: AnnotationStatus
    created_at: str


class AnnotationItem(BaseModel):
    number: int
    html_url: str
    title: str
    text: str
    type: Optional[AnnotationType]
    status: AnnotationStatus
    anchor: Dict[str, Any]
    created_at: str
    updated_at: str
    # When the issue was closed; ``None`` while it is open.
    closed_at: Optional[str] = None
    author: Optional[str]


class AnnotationList(BaseModel):
    items: List[AnnotationItem]


class StatusChangeRequest(BaseModel):
    status: Literal["open", "done"]

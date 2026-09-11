"""Progress API. PUT and the sendBeacon endpoint share one synchronous write."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..db import db

router = APIRouter(prefix="/api/books", tags=["progress"])


class Progress(BaseModel):
    section_idx: int = 0
    word_idx: int = 0
    ms_into_section: int = 0
    percent: float = 0
    #: was the player playing when this snapshot was taken?
    active: int = 0
    #: global-ms start of section_idx in the manifest that produced it —
    #: lets resume skip re-deriving the global axis
    section_start_ms: int = 0


def _put(book_id: str, body: Progress) -> dict:
    if not db.get_book(book_id):
        raise HTTPException(404, "no such book")
    db.set_progress(book_id, body.section_idx, body.word_idx,
                    body.ms_into_section, body.percent,
                    active=body.active, section_start_ms=body.section_start_ms)
    return {"ok": True}


@router.get("/{book_id}/progress")
def get_progress(book_id: str):
    if not db.get_book(book_id):
        raise HTTPException(404, "no such book")
    return db.get_progress(book_id) or {"book_id": book_id, "section_idx": 0,
                                        "word_idx": 0, "ms_into_section": 0,
                                        "percent": 0}


@router.put("/{book_id}/progress")
def put_progress(book_id: str, body: Progress):
    return _put(book_id, body)


@router.post("/{book_id}/progress/beacon")
async def beacon_progress(book_id: str, request: Request):
    # sendBeacon posts text/plain; FastAPI's model parsing only handles JSON
    # media types, so parse the raw body ourselves or every beacon 422s.
    import json

    try:
        body = Progress(**json.loads(await request.body()))
    except Exception:
        raise HTTPException(422, "bad beacon payload")
    return _put(book_id, body)

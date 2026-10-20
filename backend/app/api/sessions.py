"""Reading-session API: beacon-written sittings + aggregates for the
statistics page."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..db import db

router = APIRouter(prefix="/api", tags=["sessions"])


class SessionIn(BaseModel):
    book_id: str
    started_at: float
    ended_at: float
    duration_s: float = Field(ge=0)


def _post(s: SessionIn) -> dict:
    rec = db.add_session(s.book_id, s.started_at, s.ended_at, s.duration_s)
    if rec is None:
        # unknown book or sub-second sitting — nothing worth recording
        return {"ok": False}
    return {"ok": True, "id": rec["id"]}


@router.post("/sessions")
def post_session(s: SessionIn) -> dict:
    return _post(s)


@router.post("/sessions/beacon")
async def beacon_session(request: Request) -> dict:
    # sendBeacon posts text/plain; FastAPI's model parsing only handles JSON
    # media types, so parse the raw body ourselves or every beacon 422s.
    try:
        body = SessionIn(**json.loads(await request.body()))
    except Exception:
        raise HTTPException(422, "bad beacon payload")
    return _post(body)


@router.get("/stats")
def get_stats(days: int = 14) -> dict:
    if not 1 <= days <= 90:
        raise HTTPException(422, "days must be 1..90")
    return db.stats(days=days)

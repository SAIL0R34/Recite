"""Reading-session API: beacon-written sittings + aggregates for the
statistics page."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..db import db

router = APIRouter(prefix="/api", tags=["sessions"])


class SessionIn(BaseModel):
    book_id: str
    started_at: float
    ended_at: float
    duration_s: float = Field(ge=0)


@router.post("/sessions")
def post_session(s: SessionIn) -> dict:
    rec = db.add_session(s.book_id, s.started_at, s.ended_at, s.duration_s)
    if rec is None:
        # unknown book or sub-second sitting — nothing worth recording
        return {"ok": False}
    return {"ok": True, "id": rec["id"]}


@router.get("/stats")
def get_stats(days: int = 14) -> dict:
    if not 1 <= days <= 90:
        raise HTTPException(422, "days must be 1..90")
    return db.stats(days=days)

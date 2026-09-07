"""Reader highlights — user-marked passages of the book text."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import db

router = APIRouter(prefix="/api/books", tags=["highlights"])

COLORS = {"amber", "green", "sky", "rose"}


class Highlight(BaseModel):
    section_idx: int
    para_idx: int
    start_ti: int
    end_ti: int
    color: str = "amber"
    text: str = ""


@router.get("/{book_id}/high")
def list_highlights(book_id: str):
    return db.list_highlights(book_id)


@router.post("/{book_id}/high")
def add_highlight(book_id: str, body: Highlight):
    if not db.get_book(book_id):
        raise HTTPException(404, "no such book")
    if body.color not in COLORS:
        raise HTTPException(400, "unknown color")
    if body.end_ti < body.start_ti:
        raise HTTPException(400, "empty range")
    return db.add_highlight(
        book_id, body.section_idx, body.para_idx, body.start_ti,
        body.end_ti, body.color, body.text[:500])


@router.delete("/{book_id}/high/{highlight_id}")
def delete_highlight(book_id: str, highlight_id: str):
    db.delete_highlight(highlight_id)
    return {"ok": True}

"""Bookmarks API."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..db import db

router = APIRouter(prefix="/api/books", tags=["bookmarks"])


class Bookmark(BaseModel):
    name: str = ""
    section_idx: int
    ms: float


@router.get("/{book_id}/bookmarks")
def list_bookmarks(book_id: str):
    return db.list_bookmarks(book_id)


@router.post("/{book_id}/bookmarks")
def add_bookmark(book_id: str, body: Bookmark):
    if not db.get_book(book_id):
        raise HTTPException(404, "no such book")
    return db.add_bookmark(book_id, body.name, body.section_idx, body.ms)


@router.delete("/{book_id}/bookmarks/{bookmark_id}")
def delete_bookmark(book_id: str, bookmark_id: str):
    db.delete_bookmark(bookmark_id)  # id is globally unique
    return {"ok": True}


class BookmarkPatch(BaseModel):
    name: str


@router.patch("/{book_id}/bookmarks/{bookmark_id}")
def rename_bookmark(book_id: str, bookmark_id: str, body: BookmarkPatch):
    if not db.get_book(book_id):
        raise HTTPException(404, "no such book")
    rec = db.rename_bookmark(bookmark_id, body.name)
    if rec is None:
        raise HTTPException(404, "no such bookmark")
    return rec

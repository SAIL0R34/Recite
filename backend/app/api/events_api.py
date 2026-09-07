"""SSE events + generate trigger (keeps gen_queue import lazy so the app boots
even before the TTS package is fully wired)."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException
from sse_starlette.sse import EventSourceResponse

from .. import events, manifestio
from ..db import db

router = APIRouter(prefix="/api/books", tags=["events"])


@router.get("/{book_id}/events")
async def book_events(book_id: str):
    if not db.get_book(book_id):
        raise HTTPException(404, "no such book")
    sub = events.subscribe(book_id)

    async def emit():
        m = manifestio.load(book_id)
        if m:
            yield {"event": "status", "data": json.dumps(manifestio.generation_summary(m))}
        async for msg in sub.stream():
            yield {"event": msg["event"], "data": json.dumps(msg["data"])}

    return EventSourceResponse(emit())


@router.post("/{book_id}/generate")
async def generate(book_id: str, boost: int | None = None):
    if not db.get_book(book_id):
        raise HTTPException(404, "no such book")
    from ..tts import gen_queue
    await asyncio.to_thread(gen_queue.request_generation, book_id,
                            [boost] if boost is not None else None)
    return {"ok": True}

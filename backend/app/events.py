"""In-process pub/sub for generation progress → SSE. Thread-safe publish."""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from typing import AsyncIterator

_loop: asyncio.AbstractEventLoop | None = None
_subs: dict = defaultdict(list)
_lock = asyncio.Lock()


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


class Subscription:
    def __init__(self, book_id: str):
        self.book_id = book_id
        self.q: asyncio.Queue = asyncio.Queue()

    async def read(self):
        while True:
            yield await self.q.get()

    async def stream(self) -> AsyncIterator[dict]:
        async for msg in self.read():
            yield msg


def subscribe(book_id: str) -> Subscription:
    sub = Subscription(book_id)
    _subs[book_id].append(sub)
    return sub


def unsubscribe(sub: Subscription) -> None:
    try:
        _subs[sub.book_id].remove(sub)
    except ValueError:
        pass


def publish(book_id: str, event: str, data: dict) -> None:
    """Called from worker threads."""
    msg = {"event": event, "data": data, "ts": time.time()}
    if _loop is None:
        return
    def _deliver():
        for sub in list(_subs.get(book_id, [])):
            try:
                sub.q.put_nowait(msg)
            except Exception:
                pass
    try:
        _loop.call_soon_threadsafe(_deliver)
    except RuntimeError:
        pass  # loop closed during shutdown

"""Recite backend: FastAPI app, /api routes, static SPA mount + fallback."""
from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, events
from .api import books, bookmarks, events_api, progress, settings_api
from .db import db

app = FastAPI(title="recite")

for r in (books.router, progress.router, bookmarks.router,
          settings_api.router, events_api.router):
    app.include_router(r)


@app.on_event("startup")
async def startup():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    db.init()
    events.bind_loop(asyncio.get_running_loop())
    try:
        from .tts import gen_queue
        gen_queue.start()
        gen_queue.recover()
    except Exception as e:  # TTS optional at boot; ingest must work regardless
        import logging
        logging.getLogger("recite").warning("gen queue unavailable: %s", e)


# ------------------------------------------------------------- static SPA
DIST = config.FRONTEND_DIST
if DIST.exists() and (DIST / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")

    @app.get("/{path:path}")
    async def spa_fallback(path: str, request: Request):
        if path.startswith("api/"):
            return JSONResponse({"detail": "not found"}, status_code=404)
        f = (DIST / path).resolve()
        if f.is_file() and str(f).startswith(str(DIST.resolve())):
            return FileResponse(f)
        return FileResponse(DIST / "index.html")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)

"""Recite backend: FastAPI app, /api routes, static SPA mount + fallback."""
from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, events
from .api import books, bookmarks, events_api, highlights, progress, settings_api
from .db import db

app = FastAPI(title="recite")
# JSON payloads run to megabytes (document, manifest); gzip cuts ~5-6x.
app.add_middleware(GZipMiddleware, minimum_size=2048)

for r in (books.router, progress.router, bookmarks.router, highlights.router,
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
    try:
        from .ingest import rechunk
        for r in rechunk.recheck_all():
            import logging
            logging.getLogger("recite").info(
                "rechunked %s: kept %d/%d sections, %d chunks to regenerate",
                r["book_id"], r["sections_kept"], r["sections_total"],
                r["sections_reset"])
    except Exception as e:
        import logging
        logging.getLogger("recite").warning("startup rechunk failed: %s", e)


# ------------------------------------------------------------- static SPA
DIST = config.FRONTEND_DIST
if DIST.exists() and (DIST / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=str(DIST / "assets")), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html",
                            headers={"Cache-Control": "no-cache"})

    @app.get("/{path:path}")
    async def spa_fallback(path: str, request: Request):
        if path.startswith("api/"):
            return JSONResponse({"detail": "not found"}, status_code=404)
        f = (DIST / path).resolve()
        if f.is_file() and str(f).startswith(str(DIST.resolve())):
            return FileResponse(f)
        return FileResponse(DIST / "index.html",
                            headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT)

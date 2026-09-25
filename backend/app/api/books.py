"""Books API: list / add / delete / document / manifest / audio / status."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import config, events, manifestio
from ..db import db
from ..ingest.service import IngestError, ingest_file
from ..tts import gen_queue

router = APIRouter(prefix="/api/books", tags=["books"])


class AddBook(BaseModel):
    path: str


@router.get("/library")
def library_dir(depth: int = 4):
    """List readable book files under BOOKS_DIR for the Add dialog."""
    root = config.BOOKS_DIR
    out = []
    if not root.exists():
        return out

    def walk(d: Path, d_depth: int):
        try:
            entries = sorted(d.iterdir())
        except OSError:
            return
        for e in entries:
            if e.name.startswith("."):
                continue
            if e.is_dir() and d_depth < depth:
                walk(e, d_depth + 1)
            elif e.suffix.lower() in (".pdf", ".epub"):
                try:
                    size = e.stat().st_size
                except OSError:
                    size = 0
                out.append({"path": str(e), "name": e.stem, "size": size})
    walk(root, 0)
    return out


@router.get("")
def list_books():
    books = db.list_books()
    for b in books:
        try:
            b["warnings"] = json.loads(b.get("warnings") or "[]")
        except json.JSONDecodeError:
            b["warnings"] = []
        # narration progress for freshly added books (None before the
        # manifest exists, i.e. mid-ingest or a seeded row)
        try:
            m = manifestio.load(b["id"])
            if m:
                s = manifestio.generation_summary(m)
                b["generation"] = {
                    "ready": s["ready"], "total": s["total"], "failed": s["failed"],
                }
                continue
        except Exception:
            pass
        b["generation"] = None
    return books


@router.post("")
def add_book(body: AddBook):
    path = Path(body.path).expanduser()
    if not path.exists():
        raise HTTPException(400, f"file not found: {path}")
    if path.suffix.lower() not in (".pdf", ".epub"):
        raise HTTPException(415, "only .pdf and .epub are supported")
    # ingest stores the resolved path (symlinks like /tmp → /private/tmp
    # would otherwise make the dedupe lookup miss)
    path = path.resolve()
    existing = db.find_book_by_path(str(path))
    if existing:
        return {"book": existing, "already_present": True}
    try:
        book = ingest_file(str(path))
    except IngestError as e:
        raise HTTPException(422, str(e))
    return {"book": book, "already_present": False}


@router.post("/sample")
def add_sample():
    """Copy the bundled public-domain sample into DATA_DIR and ingest it.

    Idempotent: the stable destination path means a second call returns the
    existing book with already_present=True (same shape as POST /api/books).
    Sample: Alice's Adventures in Wonderland (Lewis Carroll, 1865 — public
    domain), https://www.gutenberg.org/ebooks/11
    """
    if not config.SAMPLE_EPUB.is_file():
        raise HTTPException(500, "sample book missing from installation")
    dest = config.DATA_DIR / "sample-library" / "sample.epub"
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(config.SAMPLE_EPUB, dest)
    return add_book(AddBook(path=str(dest)))


@router.delete("/{book_id}")
def delete_book(book_id: str):
    if not db.get_book(book_id):
        raise HTTPException(404, "no such book")
    db.delete_book(book_id)
    shutil.rmtree(config.book_dir(book_id), ignore_errors=True)
    return {"ok": True}


def _require(book_id: str) -> dict:
    book = db.get_book(book_id)
    if not book:
        raise HTTPException(404, "no such book")
    return book


@router.get("/{book_id}/document")
def get_document(book_id: str):
    _require(book_id)
    p = config.book_file(book_id, "document.json")
    if not p.exists():
        raise HTTPException(404, "document not found")
    return FileResponse(p, media_type="application/json",
                        headers={"Cache-Control": "private, must-revalidate"})


@router.get("/{book_id}/cover")
def get_cover(book_id: str):
    """Thumbnail written at ingest; 404 when the book has none (the library
    falls back to a typographic card)."""
    _require(book_id)
    for name, media in (("cover.jpg", "image/jpeg"), ("cover.png", "image/png")):
        p = config.book_file(book_id, name)
        if p.is_file():
            return FileResponse(p, media_type=media,
                                headers={"Cache-Control": "private, max-age=86400"})
    raise HTTPException(404, "no cover")


@router.get("/{book_id}/manifest")
def get_manifest(book_id: str, timings: str = ""):
    """`?timings=none` strips per-word timings (chunks keep their offsets).

    Word data is >90% of the manifest and only needed for the section about
    to be played; the reader paints text from the slim form instantly."""
    _require(book_id)
    m = manifestio.load(book_id)
    if not m:
        raise HTTPException(404, "manifest not found")
    if timings == "none":
        m = {**m, "sections": [
            {**s, "chunks": [{k: v for k, v in c.items() if k != "words"}
                             for c in s.get("chunks", [])]}
            for s in m.get("sections", [])
        ]}
    return m


@router.get("/{book_id}/timings/{section_idx}")
def get_timings(book_id: str, section_idx: int):
    """One section with word timings, for the player only. 404 if the
    section does not exist; a pending section simply has no words."""
    _require(book_id)
    m = manifestio.load(book_id)
    if not m:
        raise HTTPException(404, "manifest not found")
    section = next((s for s in m.get("sections", [])
                    if s.get("idx") == section_idx), None)
    if section is None:
        raise HTTPException(404, f"section {section_idx} not found")
    return section


@router.get("/{book_id}/audio/{fname}")
def get_audio(book_id: str, fname: str):
    """Static file serving; FileResponse implements Range (206) for scrubbing."""
    _require(book_id)
    # section-*.mp3 is final audio; partial-*.mp3 is a playable prefix of a
    # section that is still synthesizing
    if not (fname.startswith("section-") or fname.startswith("partial-")) \
            or not fname.endswith(".mp3"):
        raise HTTPException(400, "bad audio name")
    p = config.book_file(book_id, f"audio/{fname}")
    if not p.exists() or p.is_dir():
        raise HTTPException(404, "audio not generated yet")
    return FileResponse(p, media_type="audio/mpeg", filename=fname)


@router.post("/{book_id}/rechunk")
def rechunk(book_id: str):
    """Re-plan chunks under the current rules, keeping audio for chunks
    whose text is unchanged. Sections with stale slices re-enter the queue."""
    from ..ingest import rechunk as rechunk_module
    _require(book_id)
    try:
        report = rechunk_module.rechunk_book(book_id)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))
    for sec in (report.get("reset_idxs") or []):
        events.publish(book_id, "section", {"idx": sec, "status": "pending"})
    return {"ok": True, **report}


@router.get("/{book_id}/status")
def get_status(book_id: str):
    _require(book_id)
    m = manifestio.load(book_id)
    if not m:
        raise HTTPException(404, "manifest not found")
    live = gen_queue.live_status(book_id)
    for section in m.get("sections", []):
        if section.get("idx") in live and section.get("status") == "pending":
            section["status"] = live[section["idx"]]
    return manifestio.generation_summary(m)

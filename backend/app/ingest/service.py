"""Ingest service: file on disk -> document.json + manifest.json + db row.

Public contract::

    from app.ingest.service import ingest_file, IngestError
    book = ingest_file("/abs/path/book.pdf")      # -> db.get_book(book_id)

The source file is never written to (the BOOKS library is read-only input);
everything generated lives under ``config.book_dir(book_id)``.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import logging
import os
import re
import threading
import uuid
from pathlib import Path
from typing import List, Optional, Tuple

from .. import config, db as _db_module, manifestio
from . import epub as epub_module, llm_plan, pdf as pdf_module
from .chunker import plan_sections
from .model import Document, Extraction, stitch_open_paragraphs

ENGINE = "kokoro-0.9.4"
DEFAULT_VOICE = "af_heart"
_HASH_CHUNK = 4096                    # content_hash covers the first 4 KB


class IngestError(Exception):
    """Refusal. The message is user-facing (shown by the Add-book dialog)."""

    def __init__(self, message: str, warnings: Optional[List[str]] = None):
        super().__init__(message)
        self.warnings: List[str] = list(warnings or getattr(self, "warnings", []) or [])


def _warned(msg: str, warnings: Optional[List[str]] = None) -> "IngestError":
    exc = IngestError(msg)
    exc.warnings = list(warnings or [])
    return exc


def content_hash(path: str) -> str:
    """sha256 of the first 4 KB — enough to notice a replaced file."""
    h = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            h.update(fh.read(_HASH_CHUNK))
    except OSError as exc:
        raise _warned(f"cannot read {path}: {exc}")
    return f"sha256:{h.hexdigest()}"


def _extract(path: str, fmt: str):
    if fmt == "pdf":
        return pdf_module.extract(path)
    if fmt == "epub":
        return epub_module.extract(path)
    raise _warned(f"unsupported format: .{fmt}")


def _title_from_path(path: str) -> str:
    stem = os.path.basename(path)
    stem = re.sub(r"\.(pdf|epub)$", "", stem, flags=re.I)
    return stem.strip(" \u2013-\t")


def _voice_setting() -> str:
    try:
        voice = (_db_module.db.get_settings() or {}).get("voice")
    except Exception:
        return DEFAULT_VOICE
    return voice or DEFAULT_VOICE


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=None),
                   encoding="utf-8")
    tmp.replace(path)


#: chapter-like titles end the front-matter run
_CHAPTER_T = re.compile(r"^(chapter|part|book|unit|lesson|section)\b"
                        r"|^\d+[.:]", re.I)
MAX_SECTION_WORDS = 2500


def _presplit(sections: List["object"],
              max_words: int = MAX_SECTION_WORDS
              ) -> Tuple[List["object"], List[int]]:
    """Split oversized sections into ~max-word parts and mark front matter.

    A chapter the size of a whole window (Power of Logic: ~800 chunks) makes
    the forward window meaningless — one unit of work is everything. Parts
    restore the design: the window covers a couple of sections and each one
    becomes playable within a minute. Sections before the first chapter-like
    title (preface, TOC, ...) are front matter: text only, no narration.
    Returns (sections, front_matter_idxs).
    """
    out: List["object"] = []
    for sec in sections:
        words = sum(len(s.words) for p in sec.paragraphs for s in p.sentences)
        if words <= max_words:
            out.append(sec)
            continue
        groups: List[List] = []
        cur, cur_w = [], 0
        for para in sec.paragraphs:
            pw = sum(len(s.words) for s in para.sentences)
            if cur and cur_w + pw > max_words:
                groups.append(cur)
                cur, cur_w = [], 0
            cur.append(para)
            cur_w += pw
        if cur:
            groups.append(cur)
        for i, grp in enumerate(groups):
            title = (f"{sec.title} — part {i + 1}" if sec.title
                     else f"{grp[0].text.splitlines()[0][:40] or 'Text'} "
                          f"(part {i + 1})")
            out.append(type(sec)(idx=0, title=title, paragraphs=grp))
    for i, sec in enumerate(out):
        sec.idx = i

    matches = [i for i, s in enumerate(out)
               if s.title and _CHAPTER_T.match(s.title)]
    if matches and len(matches) >= 3 and matches[0] > 0:
        front = matches[0]
        # never call the whole book front matter: only skip the lead-in
        for sec in out[:front]:
            sec.front = True
        return out, [s.idx for s in out[:front]]
    return out, []


def _write_cover(book_id: str, src: str, fmt: str) -> None:
    """Best-effort cover.jpg/png in the book dir; never fails the ingest."""
    try:
        found = (pdf_module.cover_bytes(src) if fmt == "pdf"
                 else epub_module.cover_bytes(src))
    except Exception:
        found = None
    if not found:
        return
    payload, ext = found
    config.book_dir(book_id).mkdir(parents=True, exist_ok=True)
    config.book_file(book_id, f"cover.{ext}").write_bytes(payload)
    other = "png" if ext == "jpg" else "jpg"     # stale sibling from a reingest
    config.book_file(book_id, f"cover.{other}").unlink(missing_ok=True)


def ingest_file(path: str) -> dict:
    """Ingest one book file; returns the new/updated db row.

    Raises IngestError when the file is missing, unsupported, image-heavy or
    has no extractable text.
    """
    src = Path(path).expanduser()
    try:
        exists = src.is_file()
    except OSError:
        exists = False
    if not exists:
        raise _warned(f"file not found: {path}")
    fmt = (src.suffix or "").lower().lstrip(".")
    if fmt not in ("pdf", "epub"):
        raise _warned(f"unsupported format: {src.suffix or '<no extension>'} "
                      f"(only .pdf and .epub)")
    src = src.resolve()

    # An identical file already in the library keeps its id (idempotent re-ingest).
    existing = _db_module.db.find_book_by_path(str(src))
    book_id = existing["id"] if existing else uuid.uuid4().hex[:12]

    extraction: Extraction = _extract(str(src), fmt)
    warnings: List[str] = list(extraction.warnings)
    title = (extraction.title or "").strip() or _title_from_path(str(src))
    for sec in extraction.sections:
        # PDF geometry can split one sentence across a "paragraph"; narration
        # must not stop mid-clause for a column break
        stitch_open_paragraphs(sec)
    extraction.sections, front = _presplit(extraction.sections)
    if front:
        warnings.append("front matter kept as text only (no narration)")
    document = Document(id=book_id, title=title, author=extraction.author,
                        format=fmt, source_path=str(src),
                        content_hash=content_hash(str(src)),
                        warnings=warnings, sections=extraction.sections)

    if not document.sections or not any(s.paragraphs for s in document.sections):
        raise _warned(f"empty text extraction \u2014 no readable text in "
                      f"{src.name}", warnings)

    secs = document.to_manifest_sections()
    body = [d for d in secs if d["idx"] not in front]
    # Heuristic ALWAYS: the add request must return in seconds. The LLM
    # planner (when configured) re-plans in the background after the add —
    # see arm_book — so a 600-section book never blocks on 600 chat calls.
    chunk_sections, chunk_words = plan_sections(body)
    for d in secs:
        if d["idx"] in front:
            d["chunks"] = []
            d["tts"] = False
            d["status"] = "ready"
            chunk_sections.append(d)
    chunk_sections.sort(key=lambda d: d["idx"])
    total_words = document.total_words
    if total_words < chunk_words:            # no_tts paragraphs are not spoken
        total_words = chunk_words

    _write_json(config.book_file(book_id, "document.json"), document.to_dict())
    manifestio.init_manifest(book_id, sections=chunk_sections, engine=ENGINE,
                             voice=_voice_setting())
    _write_cover(book_id, str(src), fmt)
    book = _db_module.db.add_book(book_id, str(src), title, extraction.author,
                                  fmt, warnings, total_words)
    return _db_module.db.get_book(book_id) or book


# --------------------------------------------------------------- arming

log = logging.getLogger("recite")

_ARMED: set = set()
_ARMED_LOCK = threading.Lock()


def _section_payload(doc_sec: dict) -> dict:
    """document.json section -> the shape llm_plan.plan_section expects."""
    return {
        "idx": doc_sec.get("idx"),
        "title": doc_sec.get("title"),
        "paragraphs": [
            {"idx": p.get("idx"), "no_tts": bool(p.get("no_tts")),
             "sentences": [{"text": s.get("text", "")}
                           for s in p.get("sentences") or []]}
            for p in doc_sec.get("paragraphs") or []
        ],
    }


def _manifest_chunk(idx: int, c: dict) -> dict:
    return {"idx": c["idx"], "section": idx, "para": c["para"],
            "sentence_range": list(c["sentence_range"]), "text": c["text"],
            "global_start_ms": None, "duration_ms": None,
            "status": "pending", "words": None}


def _replan_pending(book_id: str) -> None:
    """Background: LLM-replan every audio-less section, kicking the TTS
    window as the planned prefix grows. Sections whose audio already
    exists keep their chunks — boundaries lock in once spoken. Failing
    sections silently keep the heuristic plan (per-section fallback in
    llm_plan); the book always ends up generatable."""
    from ..tts import gen_queue

    try:
        dp = config.book_file(book_id, "document.json")
        if not dp.exists():
            return
        doc = json.loads(dp.read_text(encoding="utf-8"))
        payloads = {s.get("idx"): _section_payload(s)
                    for s in doc.get("sections") or []}
        manifest = manifestio.load(book_id)
        if manifest is None:
            return
        breaker = llm_plan.Breaker(config.LLM_MAX_FAILURES)
        client = llm_plan.make_client()
        llm_sections = 0
        planned = 0
        try:
            for sec in manifest.get("sections", []):
                idx = sec.get("idx")
                if sec.get("tts") is False or idx not in payloads:
                    continue
                if sec.get("status") != "pending" or any(
                        c.get("status") == "ready"
                        for c in sec.get("chunks") or []):
                    continue                     # claimed or spoken: locked
                chunks, _tw, used, _reason = llm_plan.plan_section(
                    payloads[idx], True, breaker, client=client)
                if used:
                    llm_sections += 1

                    def _mut(m, idx=idx, chunks=chunks):
                        s = next((x for x in m.get("sections", [])
                                  if x.get("idx") == idx), None)
                        if s is None:
                            return False
                        # only sections the queue never claimed: once a
                        # section synthesizes, its boundaries are locked in
                        if s.get("status") != "pending" or any(
                                c.get("status") == "ready"
                                for c in s.get("chunks") or []):
                            return False
                        s["chunks"] = [_manifest_chunk(idx, c) for c in chunks]
                        return True

                    if manifestio.update(book_id, _mut) is None:
                        return                   # book deleted mid-arm
                planned += 1
                if planned == 10 or planned % 25 == 0:
                    gen_queue.request_generation(book_id)
                if breaker.open:
                    break                        # endpoint gone bad; rest heuristic
        finally:
            client.close()
        if llm_sections:

            def _stamp(m):
                m["planner"] = f"llm:{config.LLM_MODEL}"
                return True

            manifestio.update(book_id, _stamp)
        log.info("book %s armed: %d section(s) planned, %d via llm",
                 book_id, planned, llm_sections)
        gen_queue.request_generation(book_id)
    except Exception:
        log.exception("arm/replan failed for book %s", book_id)


def arm_book(book_id: str) -> "Optional[threading.Thread]":
    """Start narration for a freshly added (or never-started) book. With
    the planner configured, a daemon thread re-plans audio-less sections
    first; otherwise the TTS window starts immediately. Idempotent per
    process; never raises (arming is best-effort — the add must succeed).
    Returns the replan thread when one is spawned (tests join it)."""
    with _ARMED_LOCK:
        if book_id in _ARMED:
            return None
        _ARMED.add(book_id)
    try:
        if llm_plan.llm_configured():
            t = threading.Thread(target=_replan_pending, args=(book_id,),
                                 name=f"recite-plan-{book_id}", daemon=True)
            t.start()
            return t
        from ..tts import gen_queue
        gen_queue.request_generation(book_id)
    except Exception:
        with _ARMED_LOCK:
            _ARMED.discard(book_id)
        log.warning("arming book %s failed", book_id, exc_info=True)
    return None

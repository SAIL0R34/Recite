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
import os
import re
import uuid
from pathlib import Path
from typing import List, Optional, Tuple

from .. import config, db as _db_module, manifestio
from . import epub as epub_module, pdf as pdf_module
from .chunker import RULE_VERSION, plan_sections
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
    book = _db_module.db.add_book(book_id, str(src), title, extraction.author,
                                  fmt, warnings, total_words)
    return _db_module.db.get_book(book_id) or book

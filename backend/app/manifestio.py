"""manifest.json v2 IO. Generation pipeline is the only writer; readers go here.

Schema (see docs/CONTRACT.md): sections hold audio path, global duration, and
chunks with word timings in ms relative to the section file start.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Optional

from . import config

_LOCKS: dict = {}
_IO_LOCK = threading.Lock()


def _lock_for(book_id: str) -> threading.Lock:
    with _IO_LOCK:
        return _LOCKS.setdefault(book_id, threading.Lock())


def manifest_path(book_id: str) -> Path:
    return config.book_file(book_id, "manifest.json")


def load(book_id: str) -> Optional[dict]:
    p = manifest_path(book_id)
    if not p.exists():
        return None
    with _lock_for(book_id):
        return json.loads(p.read_text(encoding="utf-8"))


def save(book_id: str, manifest: dict) -> None:
    p = manifest_path(book_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    with _lock_for(book_id):
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)


def init_manifest(book_id: str, sections: list, engine: str, voice: str) -> dict:
    """sections: [{idx, title, chunks:[{idx, para, sentence_range, text}]}]"""
    manifest = {
        "engine": engine,
        "voice": voice,
        "alignment": "pending",
        "created_at": time.time(),
        "sections": [
            {
                "idx": s["idx"],
                "title": s.get("title"),
                "audio": f"audio/section-{s['idx']:03d}.mp3",
                "duration_ms": None,
                "status": "pending",
                "chunks": [
                    {
                        "idx": c["idx"],
                        "section": s["idx"],
                        "para": c["para"],
                        "sentence_range": c["sentence_range"],
                        "text": c["text"],
                        "global_start_ms": None,
                        "duration_ms": None,
                        "status": "pending",
                        "words": None,
                    } for c in s["chunks"]
                ],
            } for s in sections
        ],
    }
    save(book_id, manifest)
    return manifest


def generation_summary(manifest: dict) -> dict:
    secs = manifest.get("sections", [])
    ready = sum(1 for s in secs if s.get("status") == "ready")
    failed = sum(1 for s in secs if s.get("status") == "failed")
    active = sum(1 for s in secs if s.get("status") in ("synthesizing", "aligning", "encoding"))
    return {"total": len(secs), "ready": ready, "failed": failed, "active": active,
            "alignment": manifest.get("alignment")}

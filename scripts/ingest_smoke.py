#!/usr/bin/env python
"""Ingest one real book into a throwaway data dir and print a summary.

    scripts/ingest_smoke.py /path/to/book.pdf

Nothing in the real library is modified; the document/manifest pair and a
temporary sqlite db are created under a temp dir and left behind for poking.
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app import config                          # noqa: E402
from app.db import db                           # noqa: E402
from app.ingest.service import IngestError, ingest_file  # noqa: E402


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip())
        return 2
    path = Path(argv[1]).expanduser()
    root = Path(tempfile.mkdtemp(prefix="ingest-smoke-"))
    config.DATA_DIR = root
    config.BOOKS_DIR_PATH = root / "books"
    config.DB_PATH = root / "recite.db"
    db.path = config.DB_PATH
    db.init()
    try:
        book = ingest_file(str(path))
    except IngestError as exc:
        print(f"refused: {exc}")
        for warning in getattr(exc, "warnings", []):
            print(f"  warning: {warning}")
        return 1
    document = json.loads(
        config.book_file(book["id"], "document.json").read_text("utf-8"))
    sections = document["sections"]
    paragraphs = sum(len(s["paragraphs"]) for s in sections)
    print(f"title:       {book['title']}")
    print(f"author:      {book['author']}")
    print(f"format:      {book['format']}")
    print(f"sections:    {len(sections)}")
    print(f"paragraphs:  {paragraphs}")
    print(f"words:       {book['total_words']}")
    try:                                   # db stores warnings as JSON text
        warnings = json.loads(book["warnings"] or "[]")
    except (TypeError, ValueError):
        warnings = list(book["warnings"] or [])
    for warning in warnings:
        print(f"warning:     {warning}")
    print(f"data dir:    {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

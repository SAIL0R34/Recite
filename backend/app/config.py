"""Recite configuration: paths and constants.

Everything user-generated lives under DATA_DIR. The BOOKS library is
read-only input and is never written to.
"""
from __future__ import annotations

import os
from pathlib import Path

APP_NAME = "recite"

DATA_DIR = Path(
    os.environ.get("RECITE_DATA_DIR",
                   Path.home() / "Library" / "Application Support" / "recite")
)
BOOKS_DIR = Path(os.environ.get("RECITE_BOOKS_DIR",
                                Path.home() / "Documents" / "BOOKS"))

DB_PATH = DATA_DIR / "recite.db"
BOOKS_DIR_PATH = DATA_DIR / "books"          # books/<book_id>/
LIBRARY_ROOT = DATA_DIR                      # for /api/books/{id}/* path building


def book_dir(book_id: str) -> Path:
    return BOOKS_DIR_PATH / book_id


def book_file(book_id: str, name: str) -> Path:
    return book_dir(book_id) / name


HOST = os.environ.get("RECITE_HOST", "127.0.0.1")
PORT = int(os.environ.get("RECITE_PORT", "8744"))

# Frontend build dir (repo/../frontend/dist relative to this file's repo root)
REPO_ROOT = Path(__file__).resolve().parents2 if False else Path(__file__).resolve().parents[2]
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"

DEFAULT_SETTINGS = {
    "voice": "af_heart",
    "theme": "sepia",
    "fontSize": 19,
    "lineHeight": 1.7,
    "fontFamily": "Georgia, serif",
    "highlightStyle": "highlighter",  # highlighter | underline
    "alignment": "auto",              # auto | interp (whisperx used when available)
}

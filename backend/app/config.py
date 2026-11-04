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

# Concurrent Kokoro worker threads in the generation queue. Each holds its own
# KPipeline, so 3 workers cost ~3x model memory but finish lane-2 sections
# ~3x faster on an 8+ core machine.
TTS_WORKERS = max(1, int(os.environ.get("RECITE_TTS_WORKERS", "6")))
# generation window: chunks of *audio* kept ready past the reading cursor
# (a chunk ~= 15-20 s of speech) and how long out-of-window queued sections
# linger in the cold tier before being dropped from the queue
TTS_WINDOW_CHUNKS = int(os.environ.get("RECITE_TTS_WINDOW_CHUNKS", "80"))
TTS_GRACE_S = float(os.environ.get("RECITE_TTS_GRACE", "480"))
# immediate retries for a failed section (lane-1) before it is marked failed
TTS_RETRIES = int(os.environ.get("RECITE_TTS_RETRIES", "2"))

# --- external endpoints (opt-in) ------------------------------------------
# Two optional OpenAI-compatible services. Unset = disabled: Recite then
# makes no network calls at all and book text never leaves the machine.
# Keys live in the environment only — never in the settings DB and never
# served by the API (the status routes report configured/model/base only).

# Chat endpoint (OpenAI, an OpenAI-compatible proxy, Ollama, LM Studio —
# anything that speaks POST {base}/v1/chat/completions). Drives the LLM
# chunk planner; the key is sent only when set (local servers need none).
LLM_BASE_URL = os.environ.get("RECITE_LLM_BASE_URL", "").rstrip("/")
LLM_API_KEY = os.environ.get("RECITE_LLM_API_KEY", "")
LLM_MODEL = os.environ.get("RECITE_LLM_MODEL", "")
LLM_TIMEOUT_S = float(os.environ.get("RECITE_LLM_TIMEOUT", "120"))
# consecutive planner failures before the rest of an operation falls back
# to the heuristic without asking again
LLM_MAX_FAILURES = int(os.environ.get("RECITE_LLM_MAX_FAILURES", "3"))

# Speech endpoint (POST {base}/v1/audio/speech). When set, synthesis goes
# there first and local Kokoro is the fallback; voice is engine-specific
# (Kokoro voices do not exist remotely).
TTS_BASE_URL = os.environ.get("RECITE_TTS_BASE_URL", "").rstrip("/")
TTS_API_KEY = os.environ.get("RECITE_TTS_API_KEY", "")
TTS_MODEL = os.environ.get("RECITE_TTS_MODEL", "")
TTS_REMOTE_VOICE = os.environ.get("RECITE_TTS_VOICE", "alloy")
TTS_REMOTE_TIMEOUT_S = float(os.environ.get("RECITE_TTS_TIMEOUT", "120"))

# Frontend build dir (repo/../frontend/dist relative to this file's repo root)
REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIST = REPO_ROOT / "frontend" / "dist"

# Bundled public-domain sample book for the empty-library first run.
SAMPLE_EPUB = Path(__file__).resolve().parent / "assets" / "sample.epub"

DEFAULT_SETTINGS = {
    "voice": "af_heart",
    "theme": "sepia",
    "fontSize": 19,
    "lineHeight": 1.7,
    "fontFamily": "Georgia, serif",
    "highlightStyle": "highlighter",  # highlighter | underline
    "alignment": "auto",              # auto | interp (whisperx used when available)
    "readingMode": "scroll",          # scroll | paged (columns + page turns)
    "pageAnimations": False,          # opt-in motion: page turns, smooth reveals
}

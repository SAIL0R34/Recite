# Recite

Local karaoke read-along audiobook player. Listen to any PDF/EPUB in your
library with word-by-word highlighting, scrubber, ±10 s, speed control,
bookmarks, and per-book resume. Everything stays on your machine: Kokoro-82M
TTS synthesized locally, timings stored locally, no network beyond the first
model download.

## Quick start

```bash
make install            # pip venv + npm deps
make dev                # backend + vite, opens http://localhost:5173
```

Prereqs: Python 3.12, Node ≥ 18, ffmpeg, espeak-ng (`brew install espeak-ng`).
First synthesis downloads the Kokoro model (~330 MB) once.

## Workflow

1. Add books from `~/Documents/BOOKS` (image-heavy PDFs are refused with a
   clear message).
2. Open a book — the first sections synthesize ahead of your reading position
   (lane 1) while the rest of the book generates in the background (lane 2).
3. Read along: highlighted word tracks the audio; click any word/section,
   scrub, or press `J`/`L` to jump chapters.

Data lives in `~/Library/Application Support/recite/` (SQLite + per-book
audio cache). Delete it to reset the app.

## Layout

```
backend/  FastAPI: ingest (PyMuPDF/EPUB), Kokoro TTS queue, timings, SSE, REST
frontend/ React + Vite + TS + Tailwind + zustand
docs/     CONTRACT.md — data schemas, API, player invariants
tests/    pytest (ingest, TTS, API); frontend has vitest
```

## Tests

```bash
make test
```

## Design notes

- One MP3 per section; word timings are section-relative ms. Playback is a
  single `<audio>` element with one seek path — Tauri-wrap-ready (all URLs
  relative).
- Word timings default to WhisperX forced alignment when installed
  (`pip install recite[align]`-style extra: whisperx, ctranslate2), otherwise
  pause-budget interpolation, which re-zeros every chunk.
- Milestones M0–M6 per the revised plan; see docs/CONTRACT.md.

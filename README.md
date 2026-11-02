# Recite

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-3776ab.svg)](backend/requirements.txt)
[![React 18](https://img.shields.io/badge/frontend-React%2018-61dafb.svg)](frontend/package.json)

Recite is a local, privacy-first read-along audiobook player. Drop a PDF or
EPUB from your library into it and Recite narrates the book with a
fully-offline neural voice while the text lights up word-by-word, karaoke
style. Nothing leaves your machine: synthesis runs locally via
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), timings are stored
locally, and the only network traffic is the one-time model download.

<p>
  <img src="docs/screenshots/02-reader-karaoke.png" alt="The Recite reader following along with a book, the spoken word highlighted mid-sentence" width="100%">
</p>
<p>
  <img src="docs/screenshots/01-library-sepia.png" alt="The Recite library — spines on a wooden shelf with progress ribbons" width="49.5%">
  <img src="docs/screenshots/04-reader-dark.png" alt="The same reader in the dark theme" width="49.5%">
</p>

## Features

- **Karaoke read-along** — the highlighted word tracks the narration; click
  any word to seek there, or scrub the transport bar.
- **Fully local TTS** — Kokoro-82M runs on your machine; no accounts, no API
  keys, no telemetry.
- **PDF & EPUB ingest** — two-column PDFs, heading-based sections, hyphen
  rejoining, and refusal of image-heavy scans with a clear message.
- **Read now, generate ahead** — sections near your position synthesize
  first (lane 1) while the rest of the book renders in the background
  (lane 2); narration starts while later parts are still rendering.
- **Reading tools** — bookmarks, four-color text highlights, ±10 s skips,
  speed control with pitch preservation, chapter jumps (`J`/`L`), and
  per-book resume.
- **Listening comfort** — a sleep timer (minutes or end-of-section, with a
  gentle fade-out, `Z`), OS media keys and lock-screen scrubbing with cover
  art, and a screen that stays awake while narrating. Pausing after a real
  stretch brings a quiet "you read for…" card with one confetti pop.
- **Reader comfort** — sepia/light/dark themes, font family and size, line
  height, highlighter or underline styles.
- **Live status** — section synthesis progress streams over SSE, so the
  reader shows `pending → synthesizing → ready` as audio lands.

## Quick start

```bash
make install            # creates .venv, installs backend + frontend deps
make dev                # backend + vite, opens http://localhost:5173
```

Prereqs: Python 3.12, Node ≥ 18, ffmpeg, espeak-ng (`brew install espeak-ng`).
First synthesis downloads the Kokoro model (~330 MB) once.

Production mode serves the built SPA from the backend, single port:

```bash
make build
make run                # http://localhost:8744
```

## Workflow

1. Add books from your library dir (default `~/Documents/BOOKS`;
   image-heavy PDFs are refused with a clear message).
2. Open a book — the first sections synthesize ahead of your reading
   position while the rest generates in the background.
3. Read along: the highlighted word tracks the audio; click any word or
   section, scrub, or press `J`/`L` to jump chapters. Drifting off?
   `Z` arms the sleep timer.

### Keyboard

| Key | Action |
| --- | --- |
| `Space` | play / pause |
| `←` / `→` | ±10 s — in paged mode, turn the page (`Shift` seeks ±60 s) |
| `J` / `L` | previous / next ready section |
| `B` | pin a bookmark at the playhead |
| `F` | toggle follow-the-narration |
| `/` | search the book |
| `Z` | sleep timer |
| `Esc` | close panels, re-shelve the presented book |

Data lives under the data dir (default
`~/Library/Application Support/recite/` on macOS: SQLite + per-book audio).
Delete it to reset the app. Every path is env-overridable:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RECITE_DATA_DIR` | `~/Library/Application Support/recite` | db + generated audio |
| `RECITE_BOOKS_DIR` | `~/Documents/BOOKS` | read-only input library |
| `RECITE_HOST` / `RECITE_PORT` | `127.0.0.1` / `8744` | server bind |
| `RECITE_TTS_WORKERS` | `6` | concurrent Kokoro pipelines |
| `RECITE_TTS_WINDOW_CHUNKS` | `80` | audio kept ready past the cursor |
| `RECITE_TTS_GRACE` | `480` | seconds out-of-window work stays queued |
| `RECITE_FFMPEG` / `RECITE_FFPROBE` | from `PATH` | encoder binaries |
| `RECITE_LLM_BASE_URL` | _(unset)_ | OpenAI-compatible chat endpoint for the LLM chunk planner (see below) |
| `RECITE_LLM_API_KEY` | _(unset)_ | bearer token for that endpoint; leave unset for local Ollama / LM Studio |
| `RECITE_LLM_MODEL` | _(unset)_ | model name, e.g. `gpt-4o-mini` or `qwen2.5:7b` |
| `RECITE_LLM_TIMEOUT` | `60` | seconds per planner call |
| `RECITE_LLM_MAX_FAILURES` | `3` | consecutive failures before the rest of an operation uses the heuristic |
| `RECITE_TTS_BASE_URL` | _(unset)_ | OpenAI-compatible speech endpoint for remote synthesis (see below) |
| `RECITE_TTS_API_KEY` | _(unset)_ | bearer token for that endpoint |
| `RECITE_TTS_MODEL` | _(unset)_ | model name, e.g. `tts-1` |
| `RECITE_TTS_VOICE` | `alloy` | voice for the remote engine (engine-specific; Kokoro voices do not exist remotely) |
| `RECITE_TTS_TIMEOUT` | `120` | seconds per chunk synthesis |

### External endpoints (opt-in)

Recite is local-first: with the endpoint variables unset it makes **no
network calls** and book text never leaves the machine. If you point it at
external services, two things change:

- **LLM chunk planner** (`RECITE_LLM_*`) — any OpenAI-compatible chat
  endpoint (OpenAI, an OpenAI-compatible proxy, Ollama, LM Studio) chooses
  where narration chunks break: semantic breathing points instead of the
  punctuation heuristic. The model never rewrites text — it returns
  sentence-index ranges, validated locally (coverage, char budgets,
  paragraph walls) with the heuristic as a per-section fallback. The plan
  is stored in `manifest.json` (`"planner": "llm:<model>"`), a book is
  re-asked only when you explicitly re-chunk it (the ↺ button uses the
  planner when one is configured; `?planner=heuristic` forces the rules),
  and the startup re-chunk sweep never touches the endpoint. A base URL
  with or without a trailing `/v1` both work.
- **Remote TTS engine** (`RECITE_TTS_*`) — any OpenAI-compatible
  `/v1/audio/speech` endpoint synthesizes instead of local Kokoro, which is
  the speed lever: generation stops being bound to your CPU. Any failure
  (timeout, 5xx, bad audio) falls back to local Kokoro for that chunk, and
  the manifest stamps what actually ran (`remote:<model>`,
  `remote:<model>+kokoro`, or the Kokoro version). Audio for existing
  sections is never re-synthesized on an engine switch — remove and re-add
  a book if you want it fully re-voiced.

**When configured, the text of every book you ingest, re-chunk, or
synthesize is sent to the endpoint you chose.** Keys live only in the
environment — never in the database, and never served by the API (the
status routes report `configured`/`model`/`base` only).

## Layout

```
backend/  FastAPI: ingest (PyMuPDF/EPUB), Kokoro TTS queue, timings, SSE, REST
frontend/ React + Vite + TS + Tailwind + zustand
docs/     CONTRACT.md — data schemas, API routes, player invariants
tests/    pytest (ingest, TTS, API); frontend has vitest
```

## Tests

```bash
make test
```

The ingest decision boundary (what counts as a readable book vs an
image-heavy scan) is pinned by deterministic generated fixtures — see
`backend/tests/test_ingest_boundary.py`.

## Design notes

- One MP3 per section; word timings are section-relative ms. Playback is a
  single `<audio>` element with one seek path — Tauri-wrap-ready (all URLs
  relative).
- OS integration hangs off that one element: Media Session (lock-screen
  scrubbing, media keys, cover art), a screen wake lock while narrating,
  and a sleep timer that is nothing more than a volume ramp — none of it
  touches the seek path.
- Word timings come from WhisperX forced alignment when installed
  (`whisperx`, `ctranslate2`), otherwise pause-budget interpolation, which
  re-zeros every chunk.
- The full data model, API surface, and player invariants are specified in
  [docs/CONTRACT.md](docs/CONTRACT.md).

## License

[MIT](LICENSE)

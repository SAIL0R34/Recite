# Recite — internal contract

## Data layout (`~/Library/Application Support/recite/`)

```
recite.db                      # sqlite (WAL): books, progress, bookmarks, settings
books/<book_id>/
  source.json                  # ingest metadata + content hash
  document.json                # sections → paragraphs → sentences → words
  manifest.json                # generation state + word timings (v2, section-audio)
  audio/section-000.mp3        # one MP3 per section, concat of chunk WAVs
  _work/                       # transient per-chunk WAVs, deleted on section success
```

`~/Documents/BOOKS` is read-only input — never written.

## document.json

```json
{ "id": "b3f…", "title": "…", "author": "…", "format": "pdf|epub",
  "source_path": "/…", "content_hash": "sha256:…", "warnings": ["…"],
  "sections": [ { "idx": 0, "title": "Chapter 1",
      "paragraphs": [ { "idx": 3, "page": 12, "anchor": null, "no_tts": false,
          "sentences": [ { "idx": 0, "text": "…", "words": ["…"] } ] } ] } ] }
```

## manifest.json (v2)

```json
{ "engine": "kokoro-0.9.4", "voice": "af_heart", "alignment": "whisperx|interp",
  "sections": [ { "idx": 0, "audio": "audio/section-000.mp3",
      "duration_ms": 512340, "status": "ready",
      "chunks": [ { "idx": 0, "section": 0, "para": 3,
          "sentence_range": [0, 2], "text": "…",
          "global_start_ms": 0, "duration_ms": 8420, "status": "ready",
          "words": [ { "w": 0, "s": 120, "e": 240 } ] } ] } ] }
```

- Section statuses: `pending → synthesizing → (aligning) → encoding → ready | failed`
- Word `s`/`e`: ms **relative to the section file start**; `global_start_ms`:
  chunk offset within the section. Frontend adds section start for global ms.
- Chunk word order = sentences in `sentence_range`, words in document order.

## API

| Route | Verb | Notes |
|---|---|---|
| `/api/books` | GET/POST | POST `{path}`; 422 = refusal with message |
| `/api/books/library` | GET | browse list under BOOKS_DIR |
| `/api/books/{id}` | DELETE | |
| `/api/books/{id}/document` `/manifest` `/status` | GET | |
| `/api/books/{id}/audio/section-NNN.mp3` | GET | FileResponse → Range/206 free |
| `/api/books/{id}/progress` | GET/PUT | `POST …/progress/beacon` for sendBeacon |
| `/api/books/{id}/bookmarks` | GET/POST, `DELETE …/{bid}` | |
| `/api/settings` | GET/PUT | voice, theme, fontSize, lineHeight, fontFamily, highlightStyle, alignment |
| `/api/books/{id}/events` | GET SSE | `section {idx,status}`, `generation {done}` |
| `/api/books/{id}/generate` | POST | `?boost=N` lane-1 prioritize section N |

## Player invariants

- Single `<audio>` element; `seekToGlobalMs()` is the one seek path (scrubber,
  ±10 s, chapter jump, bookmark, resume all funnel through it).
- `preservesPitch` set with both prefixes; MP3 only (Safari).
- rAF loop derives the active word (binary search); DOM class toggle, no React
  state per frame. Word index is never stored in the global store.

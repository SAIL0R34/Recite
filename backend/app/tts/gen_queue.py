"""Generation queue: pending -> synthesizing -> (aligning) -> encoding -> ready.

A small pool of worker threads (default 3, `RECITE_TTS_WORKERS`), two lanes.
Lane 1 (priority 0) is the section under the reader's cursor plus the one after
it, so playback starts instantly; lane 2 (priority 1) is the rest of the book in
document order. A PriorityQueue gives lane 1 preemption for free, and multiple
workers chew through lane 2 several sections at a time. Only one *book* runs at
once (whichever grabbed the lane first), so the CPU stays on what the reader is
looking at; workers waiting on another book re-inject their section instead of
idling on it. Each worker holds its own KPipeline (kokoro_service).

State lives only in the manifest, so any restart resumes per section and
recover() resets sections caught mid-flight. A failing section is marked failed
and the queue moves on: a worker thread must never die on a bad chunk, since a
dead worker quietly starves every book.

Public contract (used by the spine): start(), recover(), request_generation().
"""
from __future__ import annotations

import logging
import queue
import threading
import time
from typing import List, Optional

import numpy as np

from .. import config, events, manifestio
from ..db import db
from . import encode, timestamps

log = logging.getLogger("recite.gen")

IN_FLIGHT = ("synthesizing", "aligning", "encoding")
TERMINAL = ("ready", "failed")

_QUEUE: "queue.PriorityQueue" = queue.PriorityQueue()
_WORKERS: list = []      # live worker threads (bounded by config.TTS_WORKERS)
_LOCK = threading.Lock()
_STATUS_LOCK = threading.Lock()
_live: set = set()    # (book_id, idx) generating right now
_queued: set = set()  # (book_id, idx) queued, not yet started
_active_book: Optional[str] = None
_SEQ = 0


# ----------------------------------------------------------------- plumbing
def _publish(book_id: str, event: str, data: dict) -> None:
    events.publish(book_id, event, data)


def _settings() -> dict:
    try:
        return db.get_settings()
    except Exception:  # db uninitialised (tests, early boot)
        return dict(config.DEFAULT_SETTINGS)


def voice_used(settings: Optional[dict] = None) -> str:
    """Voice actually being generated with (settings key: `voice`)."""
    s = settings if settings is not None else _settings()
    return s.get("voice") or "af_heart"


def engine() -> str:
    """Manifest `engine` field, e.g. 'kokoro-0.9.4'."""
    from . import kokoro_service

    return kokoro_service.engine_string()


# Alias kept for callers that spell it out long-hand.
engine_string = engine


def start(n: Optional[int] = None) -> None:
    """Bring the worker pool to `n` threads (default config.TTS_WORKERS).
    Idempotent."""
    global _WORKERS
    want = n if n is not None else config.TTS_WORKERS
    with _LOCK:
        _WORKERS[:] = [t for t in _WORKERS if t.is_alive()]
        for _ in range(max(0, want - len(_WORKERS))):
            t = threading.Thread(target=_worker_loop,
                                 name=f"recite-tts-{len(_WORKERS)}",
                                 daemon=True)
            _WORKERS.append(t)
            t.start()
        live = len(_WORKERS)
    log.info("generation queue running with %d worker(s)", live)


def request_generation(book_id: str, boost_sections: Optional[List[int]] = None) -> int:
    """Queue every unfinished section of `book_id`; returns how many were added.

    `boost_sections` (the section the reader is on) goes first together with the
    section after it, so playback is instant while the rest trickles in.
    """
    manifest = manifestio.load(book_id)
    if manifest is None:
        log.debug("no manifest for %s, nothing to generate", book_id)
        return 0

    sections = sorted(manifest.get("sections", []), key=lambda s: s.get("idx") or 0)
    by_idx = {s.get("idx"): s for s in sections}

    lane1: List[int] = []
    for idx in boost_sections or []:
        for candidate in (idx, idx + 1):      # boost + immediate successor
            s = by_idx.get(candidate)
            if candidate not in lane1 and _needs(book_id, s):
                lane1.append(candidate)
    lane2 = [s.get("idx") for s in sections
             if s.get("idx") not in lane1 and _needs(book_id, s)]

    with _LOCK:
        for idx in lane1:
            _enqueue(0, book_id, idx)
        for idx in lane2:
            _enqueue(1, book_id, idx)
        added = len(lane1) + len(lane2)
    start()
    return added


def _needs(book_id: str, section: Optional[dict]) -> bool:
    """True unless finished, or in flight under a live worker (stale flags are
    what recover() is for)."""
    if section is None:
        return False
    status = section.get("status") or "pending"
    if status in TERMINAL:
        return False
    if status in IN_FLIGHT:
        return (book_id, section.get("idx")) not in _live
    return True


def recover() -> int:
    """Reset sections stuck in synthesizing/aligning/encoding with no live
    worker. Returns how many were reset."""
    reset = 0
    if not config.BOOKS_DIR_PATH.exists():
        return 0
    for book_dir in sorted(config.BOOKS_DIR_PATH.iterdir()):
        if not (book_dir / "manifest.json").exists():
            continue
        book_id = book_dir.name
        manifest = manifestio.load(book_id)
        if manifest is None:
            continue
        changed = False
        for section in manifest.get("sections", []):
            key = (book_id, section.get("idx"))
            if section.get("status") in IN_FLIGHT and key not in _live:
                section["status"] = "pending"
                changed = True
                reset += 1
                _publish(book_id, "section",
                         {"idx": section.get("idx"), "status": "pending"})
        if changed:
            manifestio.save(book_id, manifest)
    if reset:
        log.info("recovered %d interrupted section(s)", reset)
    return reset


# ------------------------------------------------------------------- worker
def _enqueue(priority: int, book_id: str, idx: int) -> None:
    global _SEQ
    key = (book_id, idx)
    if key in _queued or key in _live:
        return
    _queued.add(key)
    _SEQ += 1
    _QUEUE.put((priority, _SEQ, book_id, idx))


def _queued_for(book_id: Optional[str]) -> int:
    return sum(1 for (b, _i) in _queued if b == book_id)


_STOP = "__recite_stop__"


def stop(timeout: float = 5.0) -> bool:
    """Ask every worker to exit and join them; clears pending work.
    Idempotent — a later start() spawns a fresh pool."""
    with _LOCK:
        workers, _WORKERS[:] = list(_WORKERS), []
        _queued.clear()
    for _ in workers:
        _QUEUE.put((_STOP,))
    for t in workers:
        t.join(timeout)
    return all(not t.is_alive() for t in workers)


def _worker_loop() -> None:
    while True:
        try:
            item = _QUEUE.get(timeout=1.0)
        except queue.Empty:
            continue
        except OSError:
            time.sleep(0.5)
            continue
        if isinstance(item, tuple) and item and item[0] == _STOP:
            return
        try:
            _priority, _seq, book_id, idx = item
        except (TypeError, ValueError):
            continue
        requeued = False
        try:
            requeued = not _await_book_slot(book_id, item=item)
            if requeued:
                continue      # re-injected; stays queued for a later turn
            _run(book_id, idx)
        except Exception:
            log.exception("generation task failed for %s section %s", book_id, idx)
        finally:
            if not requeued:
                with _LOCK:
                    _queued.discard((book_id, idx))


def _await_book_slot(book_id: str, timeout: float = 600.0,
                     item=None) -> bool:
    """May this book run right now? One book at a time keeps the CPU on the
    book the reader is actually looking at.

    With a pool, a worker holding a section of the blocked book must not idle:
    pass its queue `item` and it is re-injected (returns False) so the worker
    goes back for work the gate currently allows."""
    global _active_book
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with _LOCK:
            if _active_book in (None, book_id):
                return True
            if _queued_for(_active_book) == 0:
                _active_book = None
                return True
            if item is not None:
                _QUEUE.put(item)
                return False
        time.sleep(0.25)
    return True  # give up waiting; run anyway rather than stall forever


def _run(book_id: str, idx: int) -> None:
    global _active_book
    _await_book_slot(book_id)
    with _LOCK:
        _live.add((book_id, idx))
        _active_book = book_id
    try:
        generate_section(book_id, idx)
    except Exception as e:
        log.warning("book %s section %s failed: %s", book_id, idx, e)
        _set_status(book_id, idx, "failed")
    finally:
        with _LOCK:
            _live.discard((book_id, idx))
            if _queued_for(book_id) == 0 and _live_for(book_id) == 0:
                _active_book = None
    _maybe_done(book_id)


def _live_for(book_id: str) -> int:
    return sum(1 for (b, _i) in _live if b == book_id)


def _set_status(book_id: str, idx, status: str) -> dict:
    """Persist + broadcast one status transition. Serialized: concurrent
    pool workers each load-mutate-save the whole manifest, and an unguarded
    writer can clobber another worker's fresher status."""
    with _STATUS_LOCK:
        manifest = manifestio.load(book_id)
        if manifest is None:
            return {}
        for section in manifest.get("sections", []):
            if section.get("idx") == idx:
                section["status"] = status
                break
        else:
            return {}
        manifestio.save(book_id, manifest)
    _publish(book_id, "section", {"idx": idx, "status": status})
    return manifest


def live_status(book_id: str) -> dict:
    """{idx: status} for sections this process is working right now — the
    manifest can lag a transition by a moment, the live set may not."""
    with _LOCK:
        return {i: "synthesizing" for (b, i) in _live if b == book_id}


def _maybe_done(book_id: str) -> None:
    """Once no section is pending or in flight, tell listeners we are done."""
    manifest = manifestio.load(book_id)
    if manifest is None:
        return
    secs = manifest.get("sections", [])
    if secs and all((s.get("status") or "") in TERMINAL for s in secs):
        _publish(book_id, "generation", {"done": True})


# -------------------------------------------------------------- one section
def generate_section(book_id: str, section_idx: int) -> None:
    """Synthesize + align + encode one section. Raises on failure; the caller
    marks it failed so the queue keeps moving."""
    from . import kokoro_service

    manifest = manifestio.load(book_id)
    if manifest is None:
        raise RuntimeError(f"no manifest for book {book_id}")
    section = next((s for s in manifest.get("sections", [])
                    if s.get("idx") == section_idx), None)
    if section is None:
        raise RuntimeError(f"section {section_idx} missing from {book_id}")
    if section.get("status") == "ready":
        return

    settings = _settings()
    voice = voice_used(settings)
    mode = timestamps.resolve_alignment_mode(settings.get("alignment"))
    book_dir = config.book_dir(book_id)
    work_dir = encode.prepare_work_dir(book_dir, section_idx)

    _set_status(book_id, section_idx, "synthesizing")
    wavs = []
    for chunk in section.get("chunks", []):
        text = (chunk.get("text") or "").strip()
        wav = encode.chunk_wav_path(work_dir, chunk.get("idx") or 0)
        if text:
            audio, sr = kokoro_service.synthesize(text, voice)
        else:  # keep chunk/wav alignment even for an empty chunk
            sr = kokoro_service.SAMPLE_RATE
            audio = np.zeros(int(0.05 * sr), dtype=np.float32)
        encode.write_wav(wav, audio, sr)
        wavs.append((chunk, wav, encode.wav_duration_ms(wav)))

    # Per-chunk timings while the WAVs still exist. Offsets are applied after
    # encoding, once the concatenated section file fixes the chunk order.
    if mode == "whisperx":
        _set_status(book_id, section_idx, "aligning")
    timed_chunks = []          # (chunk, duration_ms, words, aligned)
    whisperx_chunks = 0
    for chunk, wav, dur in wavs:
        text = chunk.get("text") or ""
        words = timestamps.words_from_text(text)
        timed = timestamps.whisperx_align(text, words, str(wav), dur) \
            if mode == "whisperx" else None
        aligned = timed is not None
        if not aligned:
            timed = timestamps.estimate_timations(text, words, dur)
        else:
            whisperx_chunks += 1
        timed_chunks.append((chunk, dur, timed, aligned))

    _set_status(book_id, section_idx, "encoding")
    audio_path = f"audio/section-{int(section_idx):03d}.mp3"
    try:
        total_ms = encode.concat_to_mp3([w for _c, w, _d in wavs],
                                        book_dir / audio_path)
    finally:
        encode.cleanup_work_dir(book_dir, section_idx)

    # Section-relative word timings; each chunk keeps its own offset so the
    # reader can binary-search one flat array.
    cursor = 0
    updates: dict = {}
    for chunk, dur, timed, aligned in timed_chunks:
        updates[chunk.get("idx")] = {
            "alignment": "whisperx" if aligned else "interp",
            "global_start_ms": cursor,
            "duration_ms": dur,
            "words": [{"w": t["w"], "s": t["s"] + cursor,
                       "e": t["e"] + cursor} for t in timed],
            "status": "ready",
        }
        cursor += dur

    # Re-read before the final write: a status transition may have landed while
    # we were encoding, and the manifest is the single source of truth.
    manifest = manifestio.load(book_id) or manifest
    section = next((s for s in manifest.get("sections", [])
                    if s.get("idx") == section_idx), section)
    for chunk in section.get("chunks", []):
        if chunk.get("idx") in updates:
            chunk.update(updates[chunk["idx"]])
    section["audio"] = audio_path
    section["duration_ms"] = total_ms
    section["status"] = "ready"
    manifest["alignment"] = ("whisperx" if whisperx_chunks and
                             whisperx_chunks == len(wavs) else "interp")
    manifest["voice"] = voice
    manifest["engine"] = engine()
    manifestio.save(book_id, manifest)
    _publish(book_id, "section", {"idx": section_idx, "status": "ready"})
    log.info("book %s section %s ready (%.1fs audio, %s timing)", book_id,
             section_idx, total_ms / 1000.0, manifest["alignment"])

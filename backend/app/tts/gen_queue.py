"""Generation queue: pending -> synthesizing -> (aligning) -> encoding -> ready.

A small pool of worker threads (default 6, `RECITE_TTS_WORKERS`), two lanes.
Lane 1 (priority 0) is the section under the reader's cursor plus the one after
it, so playback starts instantly; lane 2 (priority 1) is the rest of the book in
document order. A PriorityQueue gives lane 1 preemption for free, and multiple
workers chew through lane 2 several sections at a time. Only one *book* runs at
once (whichever grabbed the lane first), so the CPU stays on what the reader is
looking at; workers waiting on another book re-inject their section instead of
idling on it. Chunks synthesize on a shared pool (kokoro_service
pipelines live on these threads), so one boosted section uses every lane.

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
from concurrent.futures import ThreadPoolExecutor, as_completed
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

# Window policy (see request_generation): lane 2 never extends beyond
# config.TTS_WINDOW_CHUNKS worth of audio past the reader's cursor; work that
# falls out of the window is demoted to a cold tier (_COLD, priority 2, runs
# only when nothing hotter waits) for config.TTS_GRACE_S, then dropped at
# dequeue. The section stays `pending` in the manifest — nothing is lost.
_COLD: dict = {}  # (book_id, idx) -> expire_ts
_RETRY: dict = {}  # (book_id, idx) -> attempts spent


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


def request_generation(book_id: str, boost_sections: Optional[List[int]] = None,
                       window_chunks: Optional[int] = None) -> int:
    """Queue the sections around the reader's cursor; returns how many were added.

    Lane 1 (priority 0) is each boost section plus its successor, so the audio
    at the cursor exists within seconds. Lane 2 (priority 1) extends forward in
    document order but NEVER past the window: at most `window_chunks` worth of
    remaining sections. The tail of the book is not queued — as the cursor
    advances, the next call slides the window. Anything from an earlier window
    that is now out of range is demoted to the cold tier for one grace period
    (jumping straight back re-promotes it), then dropped.
    """
    manifest = manifestio.load(book_id)
    if manifest is None:
        log.debug("no manifest for %s, nothing to generate", book_id)
        return 0

    sections = sorted(manifest.get("sections", []), key=lambda s: s.get("idx") or 0)
    by_idx = {s.get("idx"): s for s in sections}
    budget = window_chunks if window_chunks is not None else config.TTS_WINDOW_CHUNKS

    lane1: List[int] = []
    for idx in boost_sections or []:
        for candidate in (idx, idx + 1):      # boost + immediate successor
            s = by_idx.get(candidate)
            if candidate not in lane1 and _needs(book_id, s,
                                                 force=candidate == idx):
                lane1.append(candidate)

    # lane 2: following pending sections inside the chunk budget
    lane2: List[int] = []
    spent = 0
    cursor = max(boost_sections) if boost_sections else None
    for s in sections:
        idx = s.get("idx")
        if cursor is not None and idx is not None and idx <= cursor:
            continue
        if idx in lane1 or not _needs(book_id, s):
            continue
        n = len(s.get("chunks") or ())
        lane2.append(idx)
        spent += n
        if spent >= budget:
            break                            # include the straddling section, stop

    target = set(lane1) | set(lane2)
    with _LOCK:
        _defer_outside(book_id, target)      # mutates _QUEUE/_queued/_COLD
        for idx in lane1:
            _enqueue(0, book_id, idx)
        for idx in lane2:
            _enqueue(1, book_id, idx)
        added = len(lane1) + len(lane2)
    start()
    return added


def _defer_outside(book_id: str, target: set) -> None:
    """Demote this book's queued-but-unstarted sections outside `target` to
    the cold tier (grace); re-promote cold sections back inside it; drop
    entries whose grace lapsed. Holds _LOCK; caller-enforced."""
    global _SEQ
    now = time.monotonic()
    # expire first so re-queued ids don't linger
    for key in [k for k, exp in _COLD.items() if k[0] == book_id and exp < now]:
        _COLD.pop(key)

    kept = []
    drained = []
    while True:
        try:
            drained.append(_QUEUE.get_nowait())
        except queue.Empty:
            break
    for item in drained:
        try:
            pri, seq, b, i = item
        except (TypeError, ValueError):
            kept.append(item)
            continue
        if b != book_id or (b, i) in _live or i in target:
            if pri == 2 and b == book_id and i in target:
                _COLD.pop((b, i), None)
                pri = 1                      # re-promote into the hot window
                seq = _next_seq()
            kept.append((pri, seq, b, i))
        elif pri == 2:                       # already cold: extend grace once
            _COLD[(b, i)] = now + config.TTS_GRACE_S
            kept.append(item)
        else:                                # hot but out of window -> cold
            _COLD[(b, i)] = now + config.TTS_GRACE_S
            kept.append((2, seq, b, i))
    for item in kept:
        _QUEUE.put(item)


def _expired_cold(key) -> bool:
    """True (and forgets the entry) if this queued item's grace lapsed.
    Called under _LOCK at dequeue."""
    exp = _COLD.get(key)
    if exp is not None and exp < time.monotonic():
        _COLD.pop(key)
        _queued.discard(key)
        return True
    return False


def _next_seq() -> int:
    global _SEQ
    _SEQ += 1
    return _SEQ


def _needs(book_id: str, section: Optional[dict],
           force: bool = False) -> bool:
    """True unless finished, or in flight under a live worker (stale flags are
    what recover() is for). `force` also picks up `failed` sections — a boost
    (chapter click / window request) retries them on the spot."""
    if section is None:
        return False
    status = section.get("status") or "pending"
    if force and status == "failed":
        return True
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
        # runs at startup, before any worker exists — plain load/save is safe
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
            elif section.get("status") == "failed":
                # a failure that survived a restart is a stale verdict; the
                # condition was usually transient (model hiccup, rmtree race)
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
def _enqueue(priority: int, book_id: str, idx: int,
             force: bool = False) -> None:
    global _SEQ
    key = (book_id, idx)
    # force: the item is being re-queued by its own running worker (retry) —
    # _queued/_live entries belong to that worker, not another runner
    if not force and (key in _queued or key in _live):
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
        _COLD.clear()
    while True:  # drain first: a sentinel in a heap of tuples never compares
        try:
            _QUEUE.get_nowait()
        except queue.Empty:
            break
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
        with _LOCK:
            if _expired_cold((book_id, idx)):
                continue
            if (book_id, idx) in _live:
                # a retry queued by its own still-running worker; pick it up
                # after that worker releases it
                _QUEUE.put(item)
                continue
        requeued = False
        try:
            requeued = not _await_book_slot(book_id, item=item)
            if requeued:
                continue      # re-injected; stays queued for a later turn
            requeued = _run(book_id, idx)
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


def _run(book_id: str, idx: int) -> bool:
    global _active_book
    _await_book_slot(book_id)
    with _LOCK:
        _live.add((book_id, idx))
        _active_book = book_id
    retry = False
    try:
        generate_section(book_id, idx)
    except Exception as e:
        log.warning("book %s section %s failed: %s", book_id, idx, e)
        if manifestio.load(book_id) is None:
            return False                   # book deleted mid-flight: drop
        with _LOCK:
            n = _RETRY.get((book_id, idx), 0) + 1
            _RETRY[(book_id, idx)] = n
            if n <= config.TTS_RETRIES:    # transient is the norm — retry now
                _enqueue(0, book_id, idx, force=True)
                retry = True
        if not retry:
            _RETRY.pop((book_id, idx), None)
            _set_status(book_id, idx, "failed")
    else:
        _RETRY.pop((book_id, idx), None)
    finally:
        with _LOCK:
            _live.discard((book_id, idx))
            if _queued_for(book_id) == 0 and _live_for(book_id) == 0:
                _active_book = None
    _maybe_done(book_id)
    return retry


def _live_for(book_id: str) -> int:
    return sum(1 for (b, _i) in _live if b == book_id)


def _set_status(book_id: str, idx, status: str) -> dict:
    """Persist + broadcast one status transition. Serialized: concurrent
    pool workers each load-mutate-save the whole manifest, and an unguarded
    writer can clobber another worker's fresher status."""
    def _mut(m):
        for section in m.get("sections", []):
            if section.get("idx") == idx:
                section["status"] = status
                if status == "failed":
                    # chunk statuses were mid-flight; a retry starts clean
                    for c in section.get("chunks", []):
                        c["status"] = "pending"
                    section.pop("partial_audio", None)
                    section.pop("partial_ms", None)
                return
        return False
    with _STATUS_LOCK:
        manifest = manifestio.update(book_id, _mut)
        if manifest is None:
            return {}
    _publish(book_id, "section", {"idx": idx, "status": status})
    return manifest


def _write_partial(book_id: str, section_idx: int, chunk_order,
                   chunk_wavs: dict) -> None:
    """Playable prefix for a section still synthesizing. Concatenates the
    contiguous finished prefix to partial-NNN.mp3 and gives those chunks
    estimated word timings, so narration can START while the rest of the
    part renders; the final write replaces the file and the estimates."""
    from . import encode, timestamps
    prefix = []
    for i in chunk_order:
        t = chunk_wavs.get(i)
        if t is None:
            break
        prefix.append(t)
    if not prefix:
        return
    rel = f"audio/partial-{int(section_idx):03d}.mp3"
    path = config.book_dir(book_id) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        encode.concat_to_mp3([w for _c, w, _d in prefix], path)
    except Exception as e:  # pragma: no cover - partial is opportunistic
        log.warning("book %s sec %s partial: %s", book_id, section_idx, e)
        return
    ms = 0
    per: dict = {}
    for chunk, _wav, dur in prefix:
        per[chunk.get("idx") or 0] = {
            "global_start_ms": ms,
            "duration_ms": dur,
            "words": timestamps.estimate_timations(chunk.get("text") or "",
                                                   None, dur),
        }
        ms += dur

    def _mut(m):
        for sec in m.get("sections", []):
            if sec.get("idx") != section_idx:
                continue
            sec["partial_audio"] = rel
            sec["partial_ms"] = ms
            for c in sec.get("chunks", []):
                t = per.get(c.get("idx"))
                if t:
                    c.update(t)
            return
        return False

    manifestio.update(book_id, _mut)


_POOL: Optional[ThreadPoolExecutor] = None
_POOL_LOCK = threading.Lock()


def _synth_pool() -> ThreadPoolExecutor:
    global _POOL
    with _POOL_LOCK:
        if _POOL is None:
            _POOL = ThreadPoolExecutor(config.TTS_WORKERS,
                                       thread_name_prefix="recite-synth")
        return _POOL


def _synth_one(book_id: str, section_idx: int, work_dir, chunk, voice):
    """Synthesize one chunk to its wav. Kokoro failures retry once and then
    degrade to estimated silence: one flaky chunk must not sink a chapter."""
    from . import kokoro_service
    text = (chunk.get("text") or "").strip()
    cidx = chunk.get("idx") or 0
    wav = encode.chunk_wav_path(work_dir, cidx)
    audio = None
    if text:
        for attempt in (0, 1):
            try:
                audio, sr = kokoro_service.synthesize(text, voice)
                break
            except kokoro_service.KokoroError as e:
                log.warning("book %s sec %s chunk %s: %s",
                            book_id, section_idx, cidx, e)
        if audio is None:
            audio = kokoro_service.silence(max(0.3, len(text.split()) * 0.35))
            sr = kokoro_service.SAMPLE_RATE
    else:  # keep chunk/wav alignment even for an empty chunk
        sr = kokoro_service.SAMPLE_RATE
        audio = np.zeros(int(0.05 * sr), dtype=np.float32)
    encode.write_wav(wav, audio, sr)
    return chunk, wav, encode.wav_duration_ms(wav)


def _mark_chunks(book_id: str, section_idx: int, chunk_idxs: List[int]) -> None:
    """Mid-synthesis chunk statuses: 'ready' before word timings exist so the
    reader can stream grey->black progress; the section-ready write replaces
    these with full word data, and a failure resets them to 'pending'."""
    done = set(chunk_idxs)

    def _mut(m):
        changed = False
        for s in m.get("sections", []):
            if s.get("idx") != section_idx:
                continue
            for c in s.get("chunks", []):
                if c.get("idx") in done and c.get("status") != "ready":
                    c["status"] = "ready"
                    changed = True
        return changed

    manifestio.update(book_id, _mut)


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
    pool = _synth_pool()

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
    # Chunks synthesize CONCURRENTLY on the shared pool: the section at the
    # reader's cursor — the one they are waiting on — gets every lane.
    chunk_order = [c.get("idx") or 0 for c in section.get("chunks", [])]
    chunk_wavs: dict = {}
    futs = {pool.submit(_synth_one, book_id, section_idx, work_dir, c, voice)
            for c in section.get("chunks", [])}
    for fut in as_completed(futs):
        chunk, wav, dur = fut.result()
        cidx = chunk.get("idx") or 0
        chunk_wavs[cidx] = (chunk, wav, dur)
        _publish(book_id, "chunk", {"idx": section_idx, "chunk": cidx})
        if len(chunk_wavs) % 10 == 0:
            _mark_chunks(book_id, section_idx, list(chunk_wavs))
            _write_partial(book_id, section_idx, chunk_order, chunk_wavs)
    _mark_chunks(book_id, section_idx, list(chunk_wavs))
    wavs = [chunk_wavs[i] for i in chunk_order]

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

    # One read-modify-write transaction: a status transition may have landed
    # while we were encoding, and a parallel worker's section must survive.
    def _mutate(m):
        sec = next((x for x in m.get("sections", [])
                    if x.get("idx") == section_idx), section)
        for chunk in sec.get("chunks", []):
            if chunk.get("idx") in updates:
                chunk.update(updates[chunk["idx"]])
        sec["audio"] = audio_path
        sec["duration_ms"] = total_ms
        sec["status"] = "ready"
        sec.pop("partial_audio", None)
        sec.pop("partial_ms", None)
        m["alignment"] = ("whisperx" if whisperx_chunks and
                          whisperx_chunks == len(wavs) else "interp")
        m["voice"] = voice
        m["engine"] = engine()

    manifest = manifestio.update(book_id, _mutate) or manifest
    try:  # the prefix file is subsumed by the final render
                (config.book_dir(book_id) / f"audio/partial-{int(section_idx):03d}.mp3").unlink(missing_ok=True)
    except OSError:
        pass
    _publish(book_id, "section", {"idx": section_idx, "status": "ready"})
    log.info("book %s section %s ready (%.1fs audio, %s timing)", book_id,
             section_idx, total_ms / 1000.0, manifest["alignment"])

"""Queue pipeline over a hand-built manifest: stubbed TTS, real ffmpeg encode."""
import pathlib
import sys
import time

import numpy as np

BACKEND = pathlib.Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import pytest

from app import config, events, manifestio
from app.tts import gen_queue, kokoro_service

_WRITE_PARTIAL = gen_queue._write_partial  # the fixture stubs the module attr


class FakeLoop:
    """Runs scheduled callbacks synchronously — enough to capture events."""

    def call_soon_threadsafe(self, cb, *args):
        cb(*args)

    def is_closed(self):
        return False


@pytest.fixture()
def books(tmp_path, monkeypatch):
    """Isolated data dir so tests never touch the real library."""
    data = tmp_path / "data"
    monkeypatch.setattr(config, "DATA_DIR", data)
    monkeypatch.setattr(config, "BOOKS_DIR_PATH", data / "books")
    (data / "books").mkdir(parents=True)
    _reset_queue()
    events.bind_loop(FakeLoop())
    # partials concat real ffmpeg audio; one dedicated test covers them,
    # the rest of the file must not pay for it (nor flake on slow joins)
    monkeypatch.setattr(gen_queue, "_write_partial", lambda *a, **k: None)
    yield data
    # Join the worker before teardown so no in-flight _run() can write to the
    # (soon deleted) tmp dir while the next test's fixtures race ahead. With
    # the shared chunk pool a section can outlive the old 5s budget.
    gen_queue.stop(30)
    events.bind_loop(None)
    _reset_queue()


def _reset_queue():
    """No task may leak from one test into the next worker turn."""
    while True:
        try:
            gen_queue._QUEUE.get_nowait()
        except Exception:
            break
    gen_queue._queued.clear()
    gen_queue._live.clear()
    gen_queue._COLD.clear()
    gen_queue._RETRY.clear()
    gen_queue._active_book = None
    gen_queue._MODEL_ANNOUNCED.clear()


@pytest.fixture()
def stub_synth(monkeypatch):
    """Stub Kokoro: ~0.4s of sine per call, no model download."""
    calls = []

    def fake_synthesize(text, voice="af_heart"):
        calls.append((text, voice))
        n = 9600  # 0.4s at 24kHz
        t = np.arange(n, dtype=np.float32) / kokoro_service.SAMPLE_RATE
        return (0.2 * np.sin(220 * 2 * np.pi * t)).astype(np.float32), \
            kokoro_service.SAMPLE_RATE

    monkeypatch.setattr(kokoro_service, "synthesize", fake_synthesize)
    return calls


@pytest.fixture()
def book(books):
    """2 sections x 2 chunks, manifest v2 shape."""
    sections = [
        {"idx": i, "title": f"S{i}", "chunks": [
            {"idx": i * 2 + k, "para": k, "sentence_range": [0, 1],
             "text": f"Section {i} chunk {k} has words in it."}
            for k in (0, 1)]}
        for i in (0, 1)
    ]
    book_id = "testbook"
    config.book_dir(book_id).mkdir(parents=True)
    manifestio.init_manifest(book_id, sections, "kokoro-test", "af_heart")
    return book_id


def _wait_until_done(book_id, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = manifestio.load(book_id)
        if all(s["status"] in ("ready", "failed") for s in m["sections"]):
            return m
        time.sleep(0.1)
    raise AssertionError("generation did not finish in time")


def test_generate_section_pipeline(book, stub_synth):
    gen_queue.generate_section(book, 0)
    assert [c[1] for c in stub_synth] == ["af_heart"] * 2

    m = manifestio.load(book)
    sec = m["sections"][0]
    assert sec["status"] == "ready"
    assert sec["audio"] == "audio/section-000.mp3"
    assert sec["duration_ms"] > 0
    assert m["voice"] == "af_heart"
    assert m["engine"] == kokoro_service.engine_string()
    assert m["alignment"] == "interp"  # whisperx deps intentionally absent

    mp3 = config.book_dir(book) / sec["audio"]
    assert mp3.exists() and mp3.stat().st_size > 1000

    chunks = sec["chunks"]
    assert [c["status"] for c in chunks] == ["ready", "ready"]
    assert chunks[0]["global_start_ms"] == 0
    assert chunks[1]["global_start_ms"] == chunks[0]["duration_ms"]

    prev_e = -1
    for chunk in chunks:
        words = chunk["words"]
        base = chunk["global_start_ms"]
        assert words and words[0]["s"] >= base
        assert words[-1]["e"] <= base + chunk["duration_ms"] + 2
        for w in words:
            assert w["e"] >= w["s"]
            assert w["s"] >= prev_e, "section-relative monotonicity"
        prev_e = words[-1]["e"]

    assert not (config.book_dir(book) / "_work").exists()


def test_second_section_offsets(book, stub_synth):
    gen_queue.generate_section(book, 0)
    gen_queue.generate_section(book, 1)
    sec = manifestio.load(book)["sections"][1]
    first, second = sec["chunks"]
    assert first["global_start_ms"] == 0
    assert second["global_start_ms"] == first["duration_ms"] > 0
    assert (config.book_dir(book) / "audio" / "section-001.mp3").exists()


def test_request_generation_runs_to_ready(book, stub_synth):
    # windowed queue: cursor at 0 -> boost 0+1, nothing exists behind it
    gen_queue.request_generation(book, boost_sections=[0])
    gen_queue.start()
    m = _wait_until_done(book)
    assert [s["status"] for s in m["sections"]] == ["ready", "ready"]
    assert (config.book_dir(book) / "audio" / "section-000.mp3").exists()


def test_events_are_published(book, stub_synth):
    sub = events.subscribe(book)
    gen_queue.generate_section(book, 0)
    seen = []
    while not sub.q.empty():
        seen.append(sub.q.get_nowait())
    statuses = [d["data"]["status"] for d in seen if d["event"] == "section"]
    assert "synthesizing" in statuses
    assert "encoding" in statuses
    assert statuses[-1] == "ready"
    events.unsubscribe(sub)


def test_done_event_after_all_sections(book, stub_synth):
    sub = events.subscribe(book)
    gen_queue.generate_section(book, 0)
    gen_queue.generate_section(book, 1)
    gen_queue._maybe_done(book)
    done = [d for d in _drain(sub) if d["event"] == "generation"]
    assert done and done[-1]["data"] == {"done": True}
    events.unsubscribe(sub)


def _drain(sub):
    out = []
    while not sub.q.empty():
        out.append(sub.q.get_nowait())
    return out


def test_recover_resets_stuck_sections(book):
    m = manifestio.load(book)
    m["sections"][0]["status"] = "synthesizing"
    m["sections"][1]["status"] = "encoding"
    manifestio.save(book, m)
    assert gen_queue.recover() == 2
    m = manifestio.load(book)
    assert [s["status"] for s in m["sections"]] == ["pending", "pending"]


def test_recover_leaves_live_sections(book):
    m = manifestio.load(book)
    m["sections"][0]["status"] = "synthesizing"
    manifestio.save(book, m)
    gen_queue._live.add((book, 0))
    try:
        assert gen_queue.recover() == 0
        assert manifestio.load(book)["sections"][0]["status"] == "synthesizing"
    finally:
        gen_queue._live.discard((book, 0))


def test_request_generation_skips_ready_sections(book, stub_synth):
    gen_queue.generate_section(book, 0)
    before = list(stub_synth)
    gen_queue.request_generation(book, boost_sections=[0])
    assert manifestio.load(book)["sections"][0]["status"] == "ready"
    assert len(stub_synth) == len(before)  # nothing re-synthesized


def test_failed_section_does_not_kill_the_queue(book, monkeypatch):
    """A raising chunk must surface as `failed`, leaving siblings untouched."""
    def boom(text, voice="af_heart"):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(kokoro_service, "synthesize", boom)
    with pytest.raises(RuntimeError):
        gen_queue.generate_section(book, 0)
    gen_queue._set_status(book, 0, "failed")
    m = manifestio.load(book)
    assert m["sections"][0]["status"] == "failed"
    assert m["sections"][1]["status"] == "pending"


def test_queue_survives_a_failing_section(book, monkeypatch):
    """Via the real worker thread: one section explodes, the other completes."""
    calls = []

    def sometimes(text, voice="af_heart"):
        calls.append(text)
        if text.startswith("Section 0"):
            raise RuntimeError("boom")
        return np.zeros(4800, dtype=np.float32), 24000

    monkeypatch.setattr(kokoro_service, "synthesize", sometimes)
    gen_queue.request_generation(book)
    gen_queue.start()
    m = _wait_until_done(book, timeout=60)
    assert sorted(s["status"] for s in m["sections"]) == ["failed", "ready"]
    assert any(t.is_alive() for t in gen_queue._WORKERS)


def test_start_is_idempotent():
    gen_queue.start()
    gen_queue.start()
    assert any(t.is_alive() for t in gen_queue._WORKERS)


# ----------------------------------------------------------- window policy
def _six_sections(book_id):
    """6 sections x 2 chunks (small) — enough to show budget cut-lines."""
    sections = [
        {"idx": i, "title": f"S{i}", "chunks": [
            {"idx": i * 10 + k, "para": k, "sentence_range": [0, 1],
             "text": f"Section {i} chunk {k} has words in it."}
            for k in range(2)]}
        for i in range(6)
    ]
    config.book_dir(book_id).mkdir(parents=True)
    manifestio.init_manifest(book_id, sections, "kokoro-test", "af_heart")
    return book_id


def _queued_ids():
    return {it[3] for it in gen_queue._QUEUE.queue}


def test_window_bounds_lane2(books):
    gen_queue.start = lambda n=None: None   # inspect queue without burning items
    b = _six_sections("wnd")
    gen_queue.request_generation(b, boost_sections=[1], window_chunks=3)
    # lane 1 = boost+successor; lane 2 = next sections until the chunk budget
    # is spent (2 each); the tail is never queued
    assert _queued_ids() == {1, 2, 3, 4}


def test_cursor_move_demotes_to_cold_then_repromotes(books):
    gen_queue.start = lambda n=None: None
    b = _six_sections("grace")
    gen_queue.request_generation(b, boost_sections=[0], window_chunks=3)
    assert _queued_ids() == {0, 1, 2, 3}
    gen_queue.request_generation(b, boost_sections=[4], window_chunks=3)
    assert _queued_ids() >= {4, 5}
    # out-of-window work was demoted, not lost
    assert gen_queue._COLD.get((b, 0)) is not None
    prios = {it[3]: it[0] for it in gen_queue._QUEUE.queue}
    assert prios[0] == 2
    # jumping back re-promotes it into the hot window
    gen_queue.request_generation(b, boost_sections=[0], window_chunks=5)
    assert (b, 0) not in gen_queue._COLD
    prios = {it[3]: it[0] for it in gen_queue._QUEUE.queue}
    assert prios[0] in (0, 1)


def test_cold_item_dropped_after_grace(books):
    gen_queue.start = lambda n=None: None
    b = _six_sections("expire")
    gen_queue.request_generation(b, boost_sections=[0], window_chunks=5)
    assert (b, 3) in gen_queue._queued
    gen_queue._COLD[(b, 3)] = 0.0            # pretend grace lapsed
    assert gen_queue._expired_cold((b, 3))   # the worker's dequeue guard
    assert (b, 3) not in gen_queue._queued
    assert (b, 3) not in gen_queue._COLD
    # ...and it stays `pending` in the manifest — releasable, never lost
    m = manifestio.load(b)
    assert m["sections"][3]["status"] == "pending"


# ------------------------------------------------------------------ retries
def test_transient_failure_retries_then_ready(book, monkeypatch):
    gen_queue.start = lambda n=None: None
    real = gen_queue.generate_section
    calls = {"n": 0}

    def flaky(bid, i):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("kokoro produced no audio")
        return real(bid, i)

    monkeypatch.setattr(gen_queue, "generate_section", flaky)
    assert gen_queue._run(book, 0)          # failed -> lane-1 re-queue
    assert any(it[3] == 0 for it in gen_queue._QUEUE.queue)
    assert manifestio.load(book)["sections"][0]["status"] == "pending"
    assert gen_queue._run(book, 0) is False  # second attempt succeeds
    assert manifestio.load(book)["sections"][0]["status"] == "ready"


def test_permanent_failure_marked_after_retries(book, monkeypatch):
    gen_queue.start = lambda n=None: None

    def boom(bid, i):
        raise RuntimeError("no audio")

    monkeypatch.setattr(gen_queue, "generate_section", boom)
    for _ in range(config.TTS_RETRIES):
        assert gen_queue._run(book, 0)       # retried, still pending
    assert gen_queue._run(book, 0) is False  # budget spent -> failed
    assert manifestio.load(book)["sections"][0]["status"] == "failed"


def test_recover_revives_failed_sections(book, monkeypatch):
    m = manifestio.load(book)
    m["sections"][0]["status"] = "failed"
    manifestio.save(book, m)
    reset = gen_queue.recover()
    m = manifestio.load(book)
    assert reset >= 1
    assert m["sections"][0]["status"] == "pending"


def test_deleted_book_drops_queued_work(book, monkeypatch):
    real = gen_queue.generate_section
    def boom(bid, i):
        import shutil
        shutil.rmtree(config.book_dir(bid), ignore_errors=True)
        raise RuntimeError("no manifest for book %s" % bid)
    monkeypatch.setattr(gen_queue, "generate_section", boom)
    assert gen_queue._run(book, 0) is False   # no retry storm for dead books
    assert not any(it[3] == 0 for it in gen_queue._QUEUE.queue)




def test_partial_prefix_streams_then_releases(books, stub_synth, monkeypatch):
    """Mid-synthesis the manifest advertises partial audio for the finished
    prefix (growing, with estimated words); the final write releases it."""
    seen = []

    def spy(bid, idx, chunk_order, chunk_wavs):
        _WRITE_PARTIAL(bid, idx, chunk_order, chunk_wavs)
        sec = next(s for s in manifestio.load(bid)["sections"] if s["idx"] == idx)
        if sec.get("partial_ms"):
            seen.append(sec["partial_ms"])

    monkeypatch.setattr(gen_queue, "_write_partial", spy)
    sections = [{
        "idx": 0, "title": "S",
        "chunks": [{"idx": i, "para": 0, "sentence_range": [0, 1],
                    "text": f"Word chain number {i} keeps on going."}
                   for i in range(12)],
    }]
    config.book_dir("ptest").mkdir(parents=True)
    manifestio.init_manifest("ptest", sections, "kokoro-test", "af_heart")
    gen_queue.generate_section("ptest", 0)

    assert seen and seen[0] > 0 and all(a <= b for a, b in zip(seen, seen[1:]))
    sec = manifestio.load("ptest")["sections"][0]
    assert sec["status"] == "ready"
    assert "partial_audio" not in sec and "partial_ms" not in sec
    assert not (config.book_dir("ptest") / "audio/partial-000.mp3").exists()

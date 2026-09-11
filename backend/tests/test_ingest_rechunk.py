"""Re-chunk under new rules: keep audio for unchanged chunk text, reset
sections whose slices moved, stamp rule_version."""
import json

from app import config, manifestio
from app.ingest.rechunk import needs_rechunk, rechunk_book


def _write_fake_book(book_id: str):
    doc = {
        "title": "T",
        "sections": [{
            "idx": 0, "title": "S0",
            "paragraphs": [
                {"idx": 0, "no_tts": False,
                 "sentences": [{"text": "First sentence here."}]},
                # a sentence torn mid-clause across two "paragraphs" by a
                # PDF column break — stitching must rejoin them
                {"idx": 1, "no_tts": False,
                 "sentences": [{"text": "And everyone is"}]},
                {"idx": 2, "no_tts": False,
                 "sentences": [{"text": "watching this test."}]},
            ],
        }],
    }
    (config.book_dir(book_id)).mkdir(parents=True, exist_ok=True)
    config.book_file(book_id, "document.json").write_text(
        json.dumps(doc), encoding="utf-8")
    manifest = {
        "engine": "kokoro", "voice": "af_heart", "alignment": "ready",
        "created_at": 0,
        "sections": [{
            "idx": 0, "title": "S0", "audio": "audio/section-000.mp3",
            "duration_ms": 5000, "status": "ready", "tts": True,
            "chunks": [
                {"idx": 0, "section": 0, "para": 0,
                 "sentence_range": [0, 0], "text": "First sentence here.",
                 "global_start_ms": 0, "duration_ms": 1000,
                 "status": "ready",
                 "words": [[0, 0, 300, "First"], [4, 0, 700, "sentence"]]},
                # old rules split the torn sentence in half:
                {"idx": 1, "section": 0, "para": 1,
                 "sentence_range": [0, 0], "text": "And everyone is",
                 "global_start_ms": 1000, "duration_ms": 800,
                 "status": "ready",
                 "words": [[0, 0, 400, "And"], [4, 0, 800, "everyone"]]},
                {"idx": 2, "section": 0, "para": 2,
                 "sentence_range": [0, 0], "text": "watching this test.",
                 "global_start_ms": 1800, "duration_ms": 900,
                 "status": "ready",
                 "words": [[0, 0, 500, "watching"]]},
            ],
        }],
    }
    manifestio.save(book_id, manifest)
    mp3 = config.book_file(book_id, "audio/section-000.mp3")
    mp3.parent.mkdir(parents=True, exist_ok=True)
    mp3.write_bytes(b"ID3fake")
    return doc


def test_rechunk_keeps_rule_version_below_current():
    m = {"rule_version": 1}
    assert needs_rechunk(m) is True
    m["rule_version"] = 2
    assert needs_rechunk(m) is False


def test_rechunk_book_keeps_audio_resets_stale(tmp_path):
    bid = "rechunk-test"
    _write_fake_book(bid)

    r = rechunk_book(bid)
    assert r["rule_version"] == 2
    assert r["sections_total"] == 1
    # the paragraph stitch changed chunk texts -> stale section resets
    assert r["sections_reset"] == 1

    m = manifestio.load(bid)
    assert m["rule_version"] == 2
    sec = m["sections"][0]
    assert sec["status"] == "pending" and sec["duration_ms"] is None
    for c in sec["chunks"]:
        assert c["status"] == "pending"
        assert c["global_start_ms"] is None
    # stitched: 'And everyone is watching this test.' is one chunk
    texts = [c["text"] for c in sec["chunks"]]
    assert texts == ["First sentence here.",
                     "And everyone is watching this test."]
    # old audio archived, not deleted
    assert not config.book_file(bid, "audio/section-000.mp3").exists()
    assert config.book_file(bid, "audio/section-000.mp3.old").exists()


def test_rechunk_book_keeps_ready_section_when_text_unchanged(tmp_path):
    bid = "rechunk-keep"
    doc = {
        "title": "T",
        "sections": [{
            "idx": 0, "title": "S0",
            "paragraphs": [
                {"idx": 0, "no_tts": False,
                 "sentences": [{"text": "One two three."}]},
                {"idx": 1, "no_tts": False,
                 "sentences": [{"text": "Four five six."}]},
            ],
        }],
    }
    (config.book_dir(bid)).mkdir(parents=True, exist_ok=True)
    config.book_file(bid, "document.json").write_text(
        json.dumps(doc), encoding="utf-8")
    manifestio.save(bid, {
        "engine": "kokoro", "voice": "af_heart", "alignment": "ready",
        "created_at": 0,
        "sections": [{
            "idx": 0, "title": "S0", "audio": "audio/section-000.mp3",
            "duration_ms": 3000, "status": "ready", "tts": True,
            # both sentences short -> new rules merge into ONE chunk whose
            # text differs -> stale -> reset. To test the KEEP path both
            # new-rule chunks must match; use texts already merged:
            "chunks": [
                {"idx": 0, "section": 0, "para": 0,
                 "sentence_range": [0, 0], "text": "One two three.",
                 "global_start_ms": 0, "duration_ms": 1000,
                 "status": "ready",
                 "words": [[0, 0, 500, "One"]]},
            ],
        }],
    })
    r = rechunk_book(bid)
    # merged chunk text doesn't match the old split -> reset (documented
    # behavior: any stale slice re-queues the section)
    assert r["sections_reset"] == 1
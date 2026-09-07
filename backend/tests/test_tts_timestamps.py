"""Interpolated word timings: monotonicity, boundaries, pause budgets."""
import pathlib
import sys

BACKEND = pathlib.Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import pytest

from app.tts import timestamps


def _gaps(words):
    return [words[i + 1]["s"] - words[i]["e"] for i in range(len(words) - 1)]


def _assert_well_formed(words, duration_ms):
    assert words, "expected timings"
    assert words[0]["s"] == 0
    assert words[-1]["e"] == int(round(duration_ms))
    prev_s = prev_e = -1
    for w in words:
        assert set(w) == {"w", "s", "e"}
        assert w["e"] >= w["s"] >= prev_s, "monotonic non-decreasing"
        assert w["e"] <= duration_ms
        prev_s, prev_e = w["s"], w["e"]
    assert [w["w"] for w in words] == list(range(len(words)))


def test_indices_are_word_offsets():
    words = timestamps.estimate_timations("one two three", None, 1000)
    assert [w["w"] for w in words] == [0, 1, 2]


def test_boundaries_and_monotonic():
    text = ("The quick brown fox jumps over the lazy dog, plainly enough. "
            "Nobody complains about this sentence at all.")
    dur = 4237
    words = timestamps.estimate_timations(text, None, dur)
    _assert_well_formed(words, dur)


def test_last_e_equals_injected_duration():
    for dur in (1, 100, 999, 8420):
        words = timestamps.estimate_timations("alpha beta gamma", None, dur)
        assert words[-1]["e"] == dur


def test_pause_budget_after_clause_punctuation():
    # "Hello," must buy the comma budget (100ms) of gap before "world.".
    words = timestamps.estimate_timations("Hello, world.", None, 1000)
    assert _gaps(words) == [100]


def test_pause_budget_after_sentence_punctuation():
    words = timestamps.estimate_timations("Hello. world", None, 1000)
    assert _gaps(words) == [200]


def test_pause_budgets_scale_with_multiple_pauses():
    text = "Alpha beta, gamma delta. epsilon zeta"
    words = timestamps.estimate_timations(text, None, 3000)
    gaps = _gaps(words)
    assert gaps[1] == 100   # after "beta,"
    assert gaps[3] == 200   # after "delta."
    assert gaps[0] == 0 and gaps[2] == 0 and gaps[4] == 0


def test_no_trailing_pause_after_last_word():
    words = timestamps.estimate_timations("Ends with a period.", None, 900)
    assert words[-1]["e"] == 900


def test_speech_scales_with_word_length():
    # Same count, same total: the long word must own more time.
    words = timestamps.estimate_timations("a bbbbbbbbbbbb", None, 700)
    assert words[1]["e"] - words[1]["s"] > words[0]["e"] - words[0]["s"]


def test_explicit_word_texts_may_be_unaligned_with_text():
    words = timestamps.estimate_timations("Completely unrelated source text",
                                         ["Short", "list"], 800)
    assert len(words) == 2
    _assert_well_formed(words, 800)


def test_word_texts_without_text_still_get_pause_budgets():
    words = timestamps.estimate_timations("", ["Hello,", "world."], 1000)
    assert _gaps(words) == [100]


def test_empty_inputs():
    assert timestamps.estimate_timations("", None, 1000) == []
    assert timestamps.estimate_timations("nothing", None, 0) == []
    assert timestamps.estimate_timations("nothing", None, -5) == []


def test_punctuation_only_chunk_still_fits_duration():
    dur = 300
    words = timestamps.estimate_timations("... !!! ,,, done", None, dur)
    _assert_well_formed(words, dur)


def test_words_from_text_is_whitespace_tokenize():
    assert timestamps.words_from_text("a  b\tc\n d") == ["a", "b", "c", "d"]


def test_resolve_alignment_mode_needs_no_whisperx():
    # ctranslate2 is deliberately absent in this environment.
    assert timestamps.resolve_alignment_mode("auto") == "interp"
    assert timestamps.resolve_alignment_mode("interp") == "interp"
    assert timestamps.align_available() is False
    # Explicit whisperx without deps must not raise; it degrades to interp.
    assert timestamps.whisperx_align("t", ["t"], "/nonexistent.wav", 10) is None


@pytest.mark.parametrize("mode", ["auto", "interp", None, "whisperx"])
def test_resolve_alignment_mode_total(mode):
    assert timestamps.resolve_alignment_mode(mode) in ("interp", "whisperx")

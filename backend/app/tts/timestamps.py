"""Word timing estimation.

Two modes:
  * "interp"  — always available, zero deps. Distributes a chunk's measured
    audio duration across its words proportionally to word length, after
    subtracting a pause budget for the punctuation that follows each word.
  * "whisperx" — optional (opt-in `recite[align]` extra). Forced alignment of
    the generated audio against the known text; see align.py.

Timings are ms, relative to the *section* file start (the caller adds the
chunk's global_start_ms). Shape: [{"w": 0, "s": 120, "e": 240}, ...]
"""
from __future__ import annotations

import re
from typing import List, Optional

# Pause budget subtracted from the audio duration before proportional speech
# allocation. Sentence-ending punctuation breathes; commas/semantics less so.
SENTENCE_PAUSE_MS = 200
CLAUSE_PAUSE_MS = 100
_SENTENCE_CHARS = ".!?"
_CLAUSE_CHARS = ",—:"  # comma, em dash, colon
_QUOTE_CLOSE = "\"'”’”«»)]}»"

_WORD_RE = re.compile(r"\S+")


def pause_budget_ms(char: Optional[str]) -> int:
    """Pause budget following a word, given the character that ends its clause."""
    if not char:
        return 0
    if char in _SENTENCE_CHARS:
        return SENTENCE_PAUSE_MS
    if char in _CLAUSE_CHARS:
        return CLAUSE_PAUSE_MS
    return 0


def _trim_closers(word: str) -> str:
    w = word.rstrip()
    while w and w[-1] in _QUOTE_CLOSE:
        w = w[:-1]
    return w


def _pause_after(word: str) -> int:
    w = _trim_closers(word)
    return pause_budget_ms(w[-1]) if w else 0


def words_from_text(text: str) -> List[str]:
    """Whitespace tokenisation used for interp timing. Kept identical to what
    the reader renders so word indices line up."""
    return _WORD_RE.findall(text or "")


def estimate_timations(text: str, word_texts: Optional[List[str]] = None,
                       duration_ms: float = 0) -> List[dict]:
    """Interpolated word timings for one chunk of audio of `duration_ms`.

    Guarantees: s/e monotonic non-decreasing, first s == 0, last e == duration_ms.
    """
    words = list(word_texts) if word_texts else words_from_text(text)
    words = [w for w in words if w]
    n = len(words)
    duration_ms = float(duration_ms)
    if n == 0 or duration_ms <= 0:
        return []

    # Pause *after* each word, sourced from the original text when we can line
    # the words up with it; otherwise from the word itself.
    pauses = [0] * n
    segments = _WORD_RE.findall(text or "")
    for i, w in enumerate(words):
        src = segments[i] if i < len(segments) else w
        p = _pause_after(src)
        pauses[i] = p if i < n - 1 else 0  # no trailing pause on the last word
    total_pause = float(sum(pauses))

    # A pathological chunk (all punctuation, tiny audio) gets its pauses scaled
    # down rather than producing a negative speech budget.
    speech_total = duration_ms - total_pause
    if speech_total <= 0:
        cap = duration_ms * 0.5
        scale = cap / total_pause if total_pause else 0.0
        pauses = [p * scale for p in pauses]
        total_pause = sum(pauses)
        speech_total = duration_ms - total_pause

    weights = [len(w) + 2 for w in words]
    total_w = float(sum(weights)) or 1.0

    out: List[dict] = []
    cursor = 0.0
    for i in range(n):
        s = cursor
        e = cursor + speech_total * (weights[i] / total_w)
        cursor = e + pauses[i]
        e = min(e, duration_ms)
        out.append({"w": i, "s": int(round(s)), "e": int(round(e))})
        if i == n - 1:
            out[-1]["e"] = int(round(duration_ms))
    return _monotonic(out, duration_ms)


def _monotonic(words: List[dict], duration_ms: float) -> List[dict]:
    """Clamp rounding artefacts so s/e never decrease and the last e is exact."""
    prev_s = prev_e = 0
    for wd in words:
        s, e = int(wd["s"]), int(wd["e"])
        s = max(prev_s, min(s, int(round(duration_ms))))
        e = max(s, min(e, int(round(duration_ms))))
        wd["s"], wd["e"] = s, e
        prev_s, prev_e = s, e
    if words:
        words[-1]["e"] = int(round(duration_ms))
    return words


# ----------------------------------------------------------------- whisperx
def align_available() -> bool:
    """True when the optional forced-alignment deps are importable."""
    from . import align

    return align.available()


def whisperx_align(text: str, word_texts: List[str], wav_path,
                   duration_ms: float) -> Optional[List[dict]]:
    """Forced-alignment timings, or None when unavailable/failed. Import of the
    heavy deps happens inside align.py so a bare install never pays for it."""
    from . import align

    return align.align_words(text, word_texts, wav_path, duration_ms)


def resolve_alignment_mode(setting: Optional[str]) -> str:
    """Map the user's `alignment` setting to a concrete mode for this run.

    "auto" (default) prefers whisperx when present, else interp.
    "interp" forces interpolation.
    "whisperx" is explicit and falls back to interp if the deps are missing.
    """
    s = (setting or "auto").lower()
    if s == "interp":
        return "interp"
    return "whisperx" if align_available() else "interp"

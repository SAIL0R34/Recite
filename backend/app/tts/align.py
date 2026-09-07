"""Optional WhisperX forced alignment.

Never imported eagerly and never required: ctranslate2/whisperx are not in the
base install (an optional `recite[align]` extra would add them). `available()`
is the single gate; every entry point returns None on absence or failure, so
gen_queue falls back to interpolation and the app never hard-fails.

Word timings here come out chunk-relative; gen_queue offsets them by the
chunk's global_start_ms before writing the manifest.
"""
from __future__ import annotations

import logging
from functools import lru_cache
from typing import List, Optional

log = logging.getLogger("recite.align")

_model = None
_meta = None


def available() -> bool:
    """Cheap, cached: are the heavy optional deps importable?"""
    return _probe()


@lru_cache(maxsize=1)
def _probe() -> bool:
    try:
        import importlib.util

        for mod in ("ctranslate2", "whisperx"):
            if importlib.util.find_spec(mod) is None:
                return False
        return True
    except Exception:
        return False


def _load_model():
    """Load wav2vec2 align model once, CPU/int8. Raises if deps are missing."""
    global _model, _meta
    if _model is not None:
        return _model, _meta
    import torch  # noqa: F401  (must exist; torch ships with kokoro)
    from aligners import load_align_model  # whisperx's aligners package

    _model, _meta = load_align_model(language_code="en", device="cpu")
    return _model, _meta


def align_words(text: str, word_texts: List[str], wav_path,
                duration_ms: float) -> Optional[List[dict]]:
    """Return [{"w","s","e"}] in ms relative to the chunk audio, else None."""
    if not available():
        return None
    try:
        return _align(text, word_texts, str(wav_path), duration_ms)
    except Exception as e:  # any failure => caller falls back to interp
        log.warning("whisperx alignment failed (%s); using interp", e)
        return None


def _align(text: str, word_texts: List[str], wav_path: str,
           duration_ms: float) -> Optional[List[dict]]:
    """Align-only pass (no transcription): whisperx.align() over one synthetic
    segment, using its wav2vec2 aligner. Mirrors the documented whisperx API."""
    import pandas as pd
    import whisperx

    model, meta = _load_model()
    segments = pd.DataFrame([{
        "id": 0, "start": 0.0, "end": float(duration_ms) / 1000.0, "text": text,
    }])
    aligned = whisperx.align(segments, model, meta, str(wav_path), device="cpu")
    rows = [r for r in aligned.to_dict("records") if r.get("word")]
    out: List[dict] = []
    for i, r in enumerate(rows[:len(word_texts)]):
        s = float(r.get("start") or 0.0) * 1000
        e = float(r.get("end") or r.get("start") or 0.0) * 1000
        out.append({"w": i, "s": int(round(s)), "e": int(round(e))})
    return _monotonic(out, duration_ms) if out else None


def _monotonic(words: List[dict], duration_ms: float) -> List[dict]:
    prev_s = prev_e = 0.0
    d = int(round(duration_ms))
    for wd in words:
        wd["s"] = int(max(prev_s, min(wd["s"], d)))
        wd["e"] = int(max(wd["s"], min(wd["e"], d)))
        prev_s, prev_e = wd["s"], wd["e"]
    if words:
        words[-1]["e"] = d
    return words

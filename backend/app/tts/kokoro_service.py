"""Kokoro TTS service — lazy, thread-safe singleton around KPipeline.

Kokoro is a heavy, model-downloading dependency (first run pulls ~330MB into
the HF cache). Nothing in this module may be imported eagerly by the rest of
the app: `get_pipeline()` is the only place that touches kokoro, and every
caller goes through `synthesize()` which returns plain numpy PCM so no torch
type leaks past this file.

Kokoro returns 24kHz float audio; we hand back float32 mono numpy + sample rate.
"""
from __future__ import annotations

import os
import threading
from typing import Tuple

import numpy as np

ENGINE_NAME = "kokoro"
ENGINE_VERSION = "0.9.4"
SAMPLE_RATE = 24000

_pipeline = None
_pipeline_lock = threading.Lock()


class KokoroError(RuntimeError):
    """Raised when the TTS engine cannot produce audio for a chunk."""


def engine_string() -> str:
    """Value for the manifest `engine` field, e.g. 'kokoro-0.9.4'."""
    try:  # prefer the real installed version over the constant
        from importlib.metadata import version

        return f"{ENGINE_NAME}-{version(ENGINE_NAME)}"
    except Exception:
        return f"{ENGINE_NAME}-{ENGINE_VERSION}"


def _device() -> str:
    """CPU unless CUDA is somehow present. MPS is deliberately avoided: Kokoro's
    model has ops without MPS support, and CPU on Apple Silicon is the target."""
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def get_pipeline(lang_code: str = "a"):
    """KPipeline(lang_code) singleton, built once under a lock.

    First call may download the model. Safe to call from multiple threads:
    the loser blocks until the winner finished constructing.
    """
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    with _pipeline_lock:
        if _pipeline is None:
            try:
                from kokoro import KPipeline
            except Exception as e:  # pragma: no cover - env-dependent
                raise KokoroError(f"kokoro is not importable: {e}") from e
            try:
                _pipeline = KPipeline(lang_code=lang_code, device=_device())
            except TypeError:
                # older/newer KPipeline without a device kwarg
                _pipeline = KPipeline(lang_code=lang_code)
            except Exception as e:
                raise KokoroError(f"failed to initialise Kokoro pipeline: {e}") from e
    return _pipeline


def _to_numpy(audio) -> Tuple[np.ndarray, int]:
    """torch tensor / numpy / list -> (float32 mono, sample rate)."""
    sr = SAMPLE_RATE
    try:
        import torch

        if isinstance(audio, torch.Tensor):
            audio = audio.detach().cpu().numpy()
    except Exception:
        pass
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim > 1:  # kokoro yields (1, N) / (N, 1) shaped output
        arr = arr.reshape(-1)
    if arr.size and not np.isfinite(arr).all():
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    return np.ascontiguousarray(arr, dtype=np.float32), sr


def synthesize(text: str, voice: str = "af_heart") -> Tuple[np.ndarray, int]:
    """Text -> (float32 mono PCM, sample_rate). Concatenates any internal
    sub-chunks Kokoro yields for the same input."""
    text = (text or "").strip()
    if not text:
        raise KokoroError("nothing to synthesize")
    pipeline = get_pipeline()
    try:
        pieces = []
        for result in pipeline(text, voice=voice):
            # 0.9.4 yields a Result dataclass with backward-compat tuple
            # iteration; older/newer builds yield a plain triple.
            audio = getattr(result, "audio", None)
            if audio is None:
                try:
                    audio = result[2]
                except Exception:
                    audio = None
            if audio is None:
                continue
            pieces.append(_to_numpy(audio)[0])
    except Exception as e:
        raise KokoroError(f"synthesis failed: {e}") from e
    if not pieces:
        raise KokoroError("kokoro produced no audio")
    return np.concatenate(pieces).astype(np.float32), SAMPLE_RATE


def silence(seconds: float, sr: int = SAMPLE_RATE) -> np.ndarray:
    return np.zeros(int(max(0.0, seconds) * sr), dtype=np.float32)

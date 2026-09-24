"""Kokoro TTS service — lazy, per-thread KPipeline instances.

Kokoro is a heavy, model-downloading dependency (first run pulls ~330MB into
the HF cache). Nothing in this module may be imported eagerly by the rest of
the app: `get_pipeline()` is the only place that touches kokoro, and every
caller goes through `synthesize()` which returns plain numpy PCM so no torch
type leaks past this file.

KPipeline instances are not thread-safe (shared g2p/espeak state), so each
worker thread builds and reuses its own instance; model weights come from the
HF page cache, so extra instances cost ~the model size, not the cache size.
Each pipeline call is limited to RECITE_TTS_THREADS torch threads so several
workers genuinely overlap instead of fighting over the whole machine.

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

_worker_local = threading.local()
_pipeline_lock = threading.Lock()
_first_pipeline_built = threading.Event()
# Set only after a KPipeline finished building (the ~330MB download happens
# inside that construction, so _first_pipeline_built alone cannot mean ready).
_pipeline_ready = threading.Event()
_ready_cbs: list = []
_cb_lock = threading.Lock()


def pipeline_ready() -> bool:
    """True once at least one pipeline is built and the model is on disk."""
    return _pipeline_ready.is_set()


def on_pipeline_ready(cb) -> None:
    """Run cb() once when the first pipeline finishes building — immediately
    if it already has. Used to end the 'model downloading' announcement."""
    fire = False
    with _cb_lock:
        if _pipeline_ready.is_set():
            fire = True
        else:
            _ready_cbs.append(cb)
    if fire:
        try:
            cb()
        except Exception:
            pass



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


def _threads_per_call() -> int:
    """Cap torch threads so N parallel workers do not oversubscribe the box.
    First caller wins (torch settings are global); workers wait for that call
    before building their own pipeline."""
    try:
        import torch

        torch.set_num_threads(max(1, int(os.environ.get("RECITE_TTS_THREADS", "2"))))
    except Exception:
        pass


def get_pipeline(lang_code: str = "a"):
    """One KPipeline per worker thread; first call may download the model.

    The thread that builds first fixes the global torch thread budget; the
    others wait on `_first_pipeline_built` so they inherit it.
    """
    pipe = getattr(_worker_local, "pipeline", None)
    if pipe is not None:
        return pipe
    if not _first_pipeline_built.is_set():
        with _pipeline_lock:
            if not _first_pipeline_built.is_set():
                _threads_per_call()
                _first_pipeline_built.set()
    else:
        _first_pipeline_built.wait(30)
    try:
        from kokoro import KPipeline
    except Exception as e:  # pragma: no cover - env-dependent
        raise KokoroError(f"kokoro is not importable: {e}") from e
    try:
        pipe = KPipeline(lang_code=lang_code, device=_device())
    except TypeError:
        # older/newer KPipeline without a device kwarg
        pipe = KPipeline(lang_code=lang_code)
    except Exception as e:
        raise KokoroError(f"failed to initialise Kokoro pipeline: {e}") from e
    _worker_local.pipeline = pipe
    if not _pipeline_ready.is_set():
        with _cb_lock:
            _pipeline_ready.set()
            cbs, _ready_cbs[:] = list(_ready_cbs), []
        for cb in cbs:
            try:
                cb()
            except Exception:
                pass
    return pipe


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
        # a wedged pipeline keeps yielding nothing; drop it so the next
        # attempt builds a fresh one
        try:
            del _worker_local.pipeline
        except AttributeError:
            pass
        raise KokoroError("kokoro produced no audio")
    return np.concatenate(pieces).astype(np.float32), SAMPLE_RATE


def silence(seconds: float, sr: int = SAMPLE_RATE) -> np.ndarray:
    return np.zeros(int(max(0.0, seconds) * sr), dtype=np.float32)

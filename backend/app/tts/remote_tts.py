"""Remote TTS engine — opt-in OpenAI-compatible speech endpoint.

When configured (config.TTS_BASE_URL + TTS_MODEL), synthesis goes here
first; any failure falls back to local Kokoro in gen_queue's dispatcher.
Same contract as kokoro_service.synthesize: text -> (float32 mono PCM,
sample rate). The endpoint returns an encoded audio blob (mp3 requested —
widest server support), which ffmpeg decodes and resamples to 24 kHz mono
so a section that mixes remote and fallback-local chunks still concatenates
cleanly in encode.concat_to_mp3. Kokoro itself is untouched.
"""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path
from typing import Tuple

import numpy as np
import soundfile as sf

from .. import config
from . import encode

SAMPLE_RATE = 24000  # matches kokoro_service; everything downstream assumes it


class RemoteTtsError(RuntimeError):
    """Raised when the remote engine cannot produce audio for a chunk."""


def remote_configured() -> bool:
    return bool(config.TTS_BASE_URL and config.TTS_MODEL)


def engine_string() -> str:
    return f"{config.TTS_MODEL} (remote)"


def status() -> dict:
    """Endpoint status for the API — the key never leaves the process."""
    return {"configured": remote_configured(), "model": config.TTS_MODEL,
            "base": config.TTS_BASE_URL, "voice": config.TTS_REMOTE_VOICE}


def _speech_url() -> str:
    base = config.TTS_BASE_URL.rstrip("/")
    if base.endswith("/v1"):
        return base + "/audio/speech"
    return base + "/v1/audio/speech"


def _fetch_audio(text: str) -> bytes:
    import httpx

    headers = {}
    if config.TTS_API_KEY:
        headers["Authorization"] = f"Bearer {config.TTS_API_KEY}"
    body = {"model": config.TTS_MODEL, "voice": config.TTS_REMOTE_VOICE,
            "input": text, "response_format": "mp3"}
    try:
        r = httpx.post(_speech_url(), json=body, headers=headers,
                       timeout=config.TTS_REMOTE_TIMEOUT_S)
    except httpx.HTTPError as e:
        raise RemoteTtsError(f"speech endpoint unreachable: {e}")
    if r.status_code != 200:
        raise RemoteTtsError(f"speech endpoint returned {r.status_code}")
    if not r.content:
        raise RemoteTtsError("speech endpoint returned no audio")
    return r.content


def _decode_to_wav24k(blob: bytes) -> np.ndarray:
    """Encoded audio -> float32 mono PCM at SAMPLE_RATE via ffmpeg (the
    encode.py argv-subprocess pattern; ffmpeg sniffs the container)."""
    with tempfile.TemporaryDirectory(prefix="recite-remote-") as td:
        src = Path(td) / "in.audio"
        dst = Path(td) / "out.wav"
        src.write_bytes(blob)
        cmd = [encode.ffmpeg_binary(), "-hide_banner", "-loglevel", "error",
               "-i", str(src), "-ar", str(SAMPLE_RATE), "-ac", "1",
               "-f", "wav", "-y", str(dst)]
        try:
            subprocess.run(cmd, capture_output=True, text=True, timeout=120,
                           check=True)
        except subprocess.CalledProcessError as e:
            raise RemoteTtsError(f"decode failed: {(e.stderr or '')[-300:]}")
        except FileNotFoundError:
            raise RemoteTtsError("ffmpeg not runnable")
        if not dst.exists() or dst.stat().st_size == 0:
            raise RemoteTtsError("decode produced no output")
        try:
            audio, sr = sf.read(str(dst), dtype="float32", always_2d=False)
        except Exception as e:
            raise RemoteTtsError(f"decode unreadable: {e}")
    arr = np.asarray(audio, dtype=np.float32).reshape(-1)
    if arr.size and not np.isfinite(arr).all():
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    return np.ascontiguousarray(arr)


def synthesize(text: str, voice: str = "") -> Tuple[np.ndarray, int]:
    """text -> (float32 mono PCM @ 24 kHz, 24000). `voice` is accepted for
    signature parity but ignored — remote voices are engine-specific and
    come from config.TTS_REMOTE_VOICE."""
    text = (text or "").strip()
    if not text:
        raise RemoteTtsError("nothing to synthesize")
    blob = _fetch_audio(text)
    audio = _decode_to_wav24k(blob)
    if not audio.size:
        raise RemoteTtsError("remote synthesis produced silence-length audio")
    return audio, SAMPLE_RATE

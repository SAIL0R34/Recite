"""Remote TTS engine: request shape, decode/resample, fallback chain,
engine stamp, status route. All HTTP is httpx.MockTransport; decode paths
run real ffmpeg (already required by encode tests)."""
from __future__ import annotations

import io
import json
import pathlib
import tempfile

import httpx
import numpy as np
import pytest
import soundfile as sf

from app import config
from app.tts import remote_tts


@pytest.fixture()
def tts_env(monkeypatch):
    monkeypatch.setattr(config, "TTS_BASE_URL", "http://tts.test")
    monkeypatch.setattr(config, "TTS_API_KEY", "sk-tts")
    monkeypatch.setattr(config, "TTS_MODEL", "test-voice-model")
    monkeypatch.setattr(config, "TTS_REMOTE_VOICE", "nova")
    monkeypatch.setattr(config, "TTS_REMOTE_TIMEOUT_S", 10.0)


def _wav_bytes(samples=2400, sr=44100, freq=220.0) -> bytes:
    t = np.arange(samples) / sr
    tone = (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    buf = io.BytesIO()
    sf.write(buf, tone, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


@pytest.fixture()
def serve_wav(tts_env, monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, content=_wav_bytes())

    def install():
        client = httpx.Client(transport=httpx.MockTransport(handler))
        monkeypatch.setattr(httpx, "post",
                            lambda *a, **kw: client.post(*a, **kw))
        return seen

    return install


def test_remote_configured_gate():
    assert remote_tts.remote_configured() is False   # unset by default


def test_synthesize_decodes_and_resamples(serve_wav):
    seen = serve_wav()
    audio, sr = remote_tts.synthesize("hello there")
    assert sr == remote_tts.SAMPLE_RATE == 24000
    assert audio.dtype == np.float32 and audio.size > 0
    # 2400 samples at 44.1kHz -> ~1302 samples at 24kHz
    assert 1000 < audio.size < 1600
    assert seen["url"] == "http://tts.test/v1/audio/speech"
    assert seen["auth"] == "Bearer sk-tts"
    assert seen["body"] == {"model": "test-voice-model", "voice": "nova",
                            "input": "hello there",
                            "response_format": "mp3"}


def test_url_dedupes_v1_suffix(tts_env, monkeypatch, serve_wav):
    monkeypatch.setattr(config, "TTS_BASE_URL", "http://tts.test/v1")
    seen = serve_wav()
    remote_tts.synthesize("x")
    assert seen["url"] == "http://tts.test/v1/audio/speech"


def test_empty_text_raises(tts_env):
    with pytest.raises(remote_tts.RemoteTtsError):
        remote_tts.synthesize("   ")


@pytest.mark.parametrize("status,reason_part", [
    (500, "returned 500"),
    (401, "returned 401"),
])
def test_http_failures_raise(tts_env, monkeypatch, status, reason_part):
    def handler(_r):
        return httpx.Response(status, json={})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "post", lambda *a, **kw: client.post(*a, **kw))
    with pytest.raises(remote_tts.RemoteTtsError, match=reason_part):
        remote_tts.synthesize("x")


def test_garbage_audio_raises(tts_env, monkeypatch):
    def handler(_r):
        return httpx.Response(200, content=b"not audio at all")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "post", lambda *a, **kw: client.post(*a, **kw))
    with pytest.raises(remote_tts.RemoteTtsError):
        remote_tts.synthesize("x")


def test_transport_error_raises(tts_env, monkeypatch):
    def handler(_r):
        raise httpx.ConnectError("down")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "post", lambda *a, **kw: client.post(*a, **kw))
    with pytest.raises(remote_tts.RemoteTtsError, match="unreachable"):
        remote_tts.synthesize("x")


# ------------------------------------------------------------ dispatcher

def _fake_kokoro(monkeypatch, marker=0.5):
    calls = {"n": 0}

    def synthesize(text, voice="af_heart"):
        calls["n"] += 1
        return (np.full(2400, marker, dtype=np.float32), 24000)

    import app.tts.kokoro_service as ks
    monkeypatch.setattr(ks, "synthesize", synthesize)
    monkeypatch.setattr(ks, "pipeline_ready", lambda: True)
    return calls


def _run_synth_one(_monkeypatch):
    from app.tts import gen_queue
    chunk = {"idx": 0, "text": "hello"}
    with tempfile.TemporaryDirectory() as td:
        wav, dur, engine = gen_queue._synth_one(
            "b", 0, pathlib.Path(td), chunk, "af_heart")[1:]
        return wav, dur, engine


def test_dispatcher_prefers_remote(tts_env, monkeypatch, serve_wav):
    serve_wav()
    kokoro = _fake_kokoro(monkeypatch, marker=0.9)
    _wav, _dur, engine = _run_synth_one(monkeypatch)
    assert engine == "remote"
    assert kokoro["n"] == 0


def test_dispatcher_falls_back_to_kokoro(tts_env, monkeypatch):
    def handler(_r):
        return httpx.Response(503, json={})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(httpx, "post", lambda *a, **kw: client.post(*a, **kw))
    kokoro = _fake_kokoro(monkeypatch, marker=0.9)
    _wav, _dur, engine = _run_synth_one(monkeypatch)
    assert engine == "local"
    assert kokoro["n"] == 1


def test_dispatcher_skips_remote_when_unconfigured(monkeypatch):
    monkeypatch.setattr(config, "TTS_BASE_URL", "")
    monkeypatch.setattr(config, "TTS_MODEL", "")
    calls = {"n": 0}

    def boom(*a, **kw):
        raise AssertionError("remote must not be called unconfigured")

    monkeypatch.setattr(remote_tts, "synthesize", boom)
    kokoro = _fake_kokoro(monkeypatch, marker=0.7)
    _wav, _dur, engine = _run_synth_one(monkeypatch)
    assert engine == "local"
    assert kokoro["n"] == 1


def test_section_engine_stamp(tts_env, monkeypatch):
    from app.tts import gen_queue
    assert gen_queue._section_engine(3, 0) == "remote:test-voice-model"
    assert gen_queue._section_engine(3, 1) == "remote:test-voice-model+kokoro"
    monkeypatch.setattr(config, "TTS_MODEL", "")
    assert gen_queue._section_engine(0, 3).startswith("kokoro")


def test_status_masks_key(tts_env):
    s = remote_tts.status()
    assert s == {"configured": True, "model": "test-voice-model",
                 "base": "http://tts.test", "voice": "nova"}
    assert "sk-tts" not in str(s)


def test_api_tts_route(tmp_path, monkeypatch, tts_env):
    monkeypatch.setattr(config, "TTS_API_KEY", "sk-secret")
    from fastapi.testclient import TestClient
    from app.main import app

    r = TestClient(app).get("/api/tts")
    assert r.status_code == 200
    assert r.json()["configured"] is True
    assert "sk-secret" not in r.text

"""Section encode: real ffmpeg concat of synthetic sine WAVs."""
import math
import pathlib
import sys

import numpy as np
import soundfile as sf

BACKEND = pathlib.Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

import pytest

from app.tts import encode

SR = 24000


def _sine(seconds, freq, sr=SR):
    n = int(seconds * sr)
    t = np.arange(n) / sr
    return (0.3 * np.sin(2 * math.pi * freq * t)).astype(np.float32)


@pytest.fixture()
def wavs(tmp_path):
    d = tmp_path / "_work" / "sec-0"
    d.mkdir(parents=True)
    out = []
    for i, (secs, freq) in enumerate([(0.5, 220.0), (0.75, 440.0), (1.0, 660.0)]):
        p = encode.chunk_wav_path(d, i)
        encode.write_wav(p, _sine(secs, freq), SR)
        assert p.exists() and sf.info(str(p)).subtype == "PCM_16"
        out.append(p)
    return out


def test_wav_durations_match_input(wavs):
    measured = [encode.wav_duration_ms(w) for w in wavs]
    assert measured == [500, 750, 1000]


def test_concat_produces_mp3(wavs, tmp_path):
    out = tmp_path / "audio" / "section-000.mp3"
    total = encode.concat_to_mp3(wavs, out)
    assert out.exists() and out.stat().st_size > 1000
    assert abs(total - sum(encode.wav_duration_ms(w) for w in wavs)) < 100


def test_mp3_duration_matches_sum(wavs, tmp_path):
    out = tmp_path / "audio" / "section-000.mp3"
    expected = sum(encode.wav_duration_ms(w) for w in wavs)  # 2250ms
    total = encode.concat_to_mp3(wavs, out)
    measured = encode.measure_duration_ms(out)
    assert abs(total - expected) <= 100, (total, expected)
    assert abs(measured - expected) <= 100, (measured, expected)


def test_global_start_offsets_are_cumulative(wavs, tmp_path):
    """The generator's cursor arithmetic: offsets must equal the running sum of
    the WAV durations that precede them."""
    durations = [encode.wav_duration_ms(w) for w in wavs]
    starts, cursor = [], 0
    for d in durations:
        starts.append(cursor)
        cursor += d
    assert starts == [0, 500, 1250]
    assert cursor == 2250


def test_cleanup_removes_work_dir(wavs, tmp_path):
    work = wavs[0].parents[1]
    encode.cleanup_work_dir(work.parents[0], 0)
    assert not work.exists()


def test_single_chunk_section(wavs, tmp_path):
    out = tmp_path / "section-001.mp3"
    total = encode.concat_to_mp3([wavs[1]], out)
    assert total == 750


def test_empty_and_missing_inputs_rejected(wavs, tmp_path):
    with pytest.raises(Exception):
        encode.concat_to_mp3([], tmp_path / "x.mp3")
    with pytest.raises(Exception):
        encode.concat_to_mp3([tmp_path / "absent.wav"], tmp_path / "x.mp3")


def test_ffmpeg_binary_is_absolute():
    assert pathlib.Path(encode.ffmpeg_binary()).is_absolute()

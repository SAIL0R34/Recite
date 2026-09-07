"""Chunk WAV -> section MP3 via the ffmpeg concat demuxer.

Per-chunk WAVs (written by the TTS step) live under
books/<id>/_work/sec-<i>/chunk-<c>.wav. We concatenate them losslessly into one
gapless stream and encode a single MP3 per section:
    ffmpeg -f concat -safe 0 -i list.txt -c:a libmp3lame -qscale:a 4 -y out.mp3

MP3 is deliberate: Safari's Opus support is partial and Web Audio decoding is
unreliable there, MP3 decodes everywhere. Paths only ever travel as argv lists
(never shell=True), so the library's odd filenames are safe.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Sequence, Union

import numpy as np
import soundfile as sf

log = logging.getLogger("recite.encode")

PathLike = Union[str, "os.PathLike"]


class EncodeError(RuntimeError):
    pass


def ffmpeg_binary() -> str:
    """ffmpeg location: $RECITE_FFMPEG, PATH, then the usual Homebrew dirs."""
    env = os.environ.get("RECITE_FFMPEG")
    if env and os.path.exists(env):
        return env
    found = shutil.which("ffmpeg")
    if found:
        return found
    for candidate in ("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if os.path.exists(candidate):
            return candidate
    raise EncodeError("ffmpeg not found; install it (brew install ffmpeg) "
                      "or set RECITE_FFMPEG to the binary path")


def write_wav(path: PathLike, audio, sr: int) -> Path:
    """Float32 PCM -> 16-bit PCM WAV (smallest lossless container ffmpeg reads)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    arr = np.asarray(audio, dtype=np.float32).reshape(-1)
    if arr.size and not np.isfinite(arr).all():
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)
    sf.write(str(path), arr, int(sr), format="WAV", subtype="PCM_16")
    return path


def wav_duration_ms(path: PathLike) -> int:
    try:
        info = sf.info(str(path))
        return int(round(info.frames / float(info.samplerate) * 1000))
    except Exception:
        return 0


def measure_duration_ms(path: PathLike) -> int:
    """Duration of an audio file in ms. ffmpeg/ffprobe is authoritative for MP3
    (its VBR estimate beats naive byte math); soundfile is the WAV fallback."""
    p = Path(path)
    for probe in (_probe_with_ffprobe, _probe_with_ffmpeg):
        try:
            return probe(p)
        except Exception:
            continue
    try:
        info = sf.info(str(p))
        return int(round(info.frames / float(info.samplerate) * 1000))
    except Exception as e:
        raise EncodeError(f"could not measure duration of {p}: {e}")


def _probe_with_ffprobe(path: Path) -> int:
    ffprobe = os.environ.get("RECITE_FFPROBE") or shutil.which("ffprobe")
    if not ffprobe:
        candidate = Path(ffmpeg_binary()).with_name("ffprobe")
        ffprobe = str(candidate) if candidate.exists() else None
    if not ffprobe:
        raise EncodeError("no ffprobe")
    out = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, timeout=60, check=True).stdout.strip()
    return int(round(float(out) * 1000))


def _probe_with_ffmpeg(path: Path) -> int:
    """Parse the trailing `time=HH:MM:SS.ms` line ffmpeg prints for -f null."""
    out = subprocess.run(
        [ffmpeg_binary(), "-hide_banner", "-i", str(path), "-f", "null", "-"],
        capture_output=True, text=True, timeout=60, check=True).stderr
    idx = out.rfind("time=")
    if idx < 0:
        raise EncodeError("no time= in ffmpeg output")
    parts = out[idx + 5:].split()[0].split(":")
    if len(parts) != 3:
        raise EncodeError(f"unparsable time= {parts!r}")
    secs = (int(parts[0]) * 60 + int(parts[1])) * 60 + float(parts[2])
    return int(round(secs * 1000))



def concat_to_mp3(wavs: Sequence[PathLike], out_mp3: PathLike) -> int:
    """Concatenate WAVs into one gapless MP3. Returns duration_ms of the result.

    Uses the concat *demuxer* (not the filter) so the join happens before
    encoding — that is what removes audible seams at chunk boundaries.
    """
    wavs = [Path(w) for w in wavs]
    if not wavs:
        raise EncodeError("no chunks to concatenate")
    missing = [w for w in wavs if not w.exists()]
    if missing:
        raise EncodeError(f"missing chunk wavs: {missing[:3]}")

    out_mp3 = Path(out_mp3)
    out_mp3.parent.mkdir(parents=True, exist_ok=True)

    fd, list_path = tempfile.mkstemp(prefix="recite-concat-", suffix=".txt")
    os.close(fd)
    try:
        with open(list_path, "w", encoding="utf-8") as fh:
            for w in wavs:
                # concat demuxer wants single quotes escaped as \'
                fh.write("file '{}'\n".format(str(w).replace("'", "'\\''")))
        cmd = [ffmpeg_binary(), "-f", "concat", "-safe", "0", "-i", list_path,
               "-c:a", "libmp3lame", "-qscale:a", "4", "-y", str(out_mp3)]
        log.debug("ffmpeg: %s", " ".join(cmd))
        try:
            subprocess.run(cmd, capture_output=True, text=True, timeout=3600,
                           check=True)
        except subprocess.CalledProcessError as e:
            raise EncodeError(f"ffmpeg concat failed: {(e.stderr or '')[-500:]}")
        except FileNotFoundError:
            raise EncodeError("ffmpeg not runnable")
    finally:
        try:
            os.unlink(list_path)
        except OSError:
            pass

    if not out_mp3.exists() or out_mp3.stat().st_size == 0:
        raise EncodeError("ffmpeg produced no output")
    return measure_duration_ms(out_mp3)


def cleanup_work_dir(book_dir: PathLike, section_idx: int) -> None:
    """Drop books/<id>/_work/sec-<i> after a successful encode."""
    d = Path(book_dir) / "_work" / f"sec-{section_idx}"
    if not d.exists():
        return
    shutil.rmtree(d, ignore_errors=True)
    work = d.parent
    try:  # tidy up the parent only when no other section is mid-flight
        if work.exists() and not any(work.iterdir()):
            work.rmdir()
    except OSError:
        pass


def prepare_work_dir(book_dir: PathLike, section_idx: int) -> Path:
    d = Path(book_dir) / "_work" / f"sec-{section_idx}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def chunk_wav_path(work_dir: PathLike, chunk_idx: int) -> Path:
    return Path(work_dir) / f"chunk-{int(chunk_idx)}.wav"

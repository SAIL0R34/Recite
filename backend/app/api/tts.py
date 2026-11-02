"""Remote TTS status: one GET, no key ever leaves the process."""
from __future__ import annotations

from fastapi import APIRouter

from ..tts import remote_tts

router = APIRouter(prefix="/api/tts", tags=["tts"])


@router.get("")
def status() -> dict:
    return remote_tts.status()

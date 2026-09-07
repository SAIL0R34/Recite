"""Settings API: whole-dict GET/PUT."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from ..db import db

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def get_settings() -> dict:
    return db.get_settings()


@router.put("")
def put_settings(values: dict[str, Any]) -> dict:
    return db.set_settings(values)

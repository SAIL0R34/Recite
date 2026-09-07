import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import app.config as appconfig  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """Every test gets its own DATA_DIR + sqlite file."""
    monkeypatch.setattr(appconfig, "DATA_DIR", tmp_path)
    monkeypatch.setattr(appconfig, "BOOKS_DIR_PATH", tmp_path / "books")
    from app.db import db
    db.path = tmp_path / "recite.db"
    db.init()
    yield tmp_path

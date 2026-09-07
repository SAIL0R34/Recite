"""User highlights API: CRUD over the /high endpoints."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from pathlib import Path

    from app.db import Database
    import app.api.highlights as hl_mod

    db = Database(Path(tmp_path) / "test.db")
    db.init()
    db.add_book("b1", "p.pdf", "Test Book", "A. Author", "pdf", [], 100)
    monkeypatch.setattr(hl_mod, "db", db)

    from app.main import app

    # no context manager: skip startup lifespan (keeps the gen-queue out of it)
    yield TestClient(app)


def test_highlights_crud(client):
    assert client.get("/api/books/b1/high").json() == []
    body = dict(section_idx=0, para_idx=3, start_ti=2, end_ti=5,
                color="green", text="quantum magic")
    r = client.post("/api/books/b1/high", json=body)
    assert r.status_code == 200
    rec = r.json()
    assert rec["color"] == "green" and rec["start_ti"] == 2

    listed = client.get("/api/books/b1/high").json()
    assert listed[0]["id"] == rec["id"]

    assert client.delete(f"/api/books/b1/high/{rec['id']}").status_code == 200
    assert client.get("/api/books/b1/high").json() == []


def test_highlight_bad_color(client):
    body = dict(section_idx=0, para_idx=0, start_ti=0, end_ti=0, color="neon")
    assert client.post("/api/books/b1/high", json=body).status_code == 400


def test_highlight_unknown_book(client):
    body = dict(section_idx=0, para_idx=0, start_ti=0, end_ti=0, color="amber")
    assert client.post("/api/books/nope/high", json=body).status_code == 404

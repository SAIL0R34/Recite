"""API contract tests — progress/bookmarks/settings/audio with a synthetic book.

Full ingest flow lives in test_ingest_*; here we seed the DB directly.
"""
import pytest
from fastapi.testclient import TestClient

from app.db import db
from app.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def book_id():
    return db.add_book("apid1", "/tmp/none.pdf", "None", "Nobody", "pdf",
                       [], 100)["id"]


def test_list_books_empty(client):
    assert client.get("/api/books").json() == []


def test_progress_roundtrip(client, book_id):
    body = {"section_idx": 2, "word_idx": 5, "ms_into_section": 1234, "percent": 0.42}
    assert client.put(f"/api/books/{book_id}/progress", json=body).status_code == 200
    got = client.get(f"/api/books/{book_id}/progress").json()
    assert got["section_idx"] == 2 and got["ms_into_section"] == 1234
    assert got["percent"] == pytest.approx(0.42)
    # beacon path (sendBeacon) writes synchronously too
    client.post(f"/api/books/{book_id}/progress/beacon",
                json={**body, "percent": 0.5})
    got = client.get(f"/api/books/{book_id}/progress").json()
    assert got["percent"] == pytest.approx(0.5)
    # the book list exposes the last-read timestamp for the continue hero
    row = next(b for b in client.get("/api/books").json()
               if b["id"] == book_id)
    assert row["last_read"] and row["last_read"] > 0


def test_progress_missing_book_404(client):
    assert client.get("/api/books/zzz/progress").status_code == 404


def test_bookmarks_crud(client, book_id):
    r = client.post(f"/api/books/{book_id}/bookmarks",
                    json={"name": "start", "section_idx": 1, "ms": 250.5})
    assert r.status_code == 200
    bid = r.json()["id"]
    created_at = r.json()["created_at"]
    assert [b["name"] for b in client.get(f"/api/books/{book_id}/bookmarks").json()] == ["start"]
    # rename via PATCH keeps id and created_at (no delete+recreate)
    r = client.patch(f"/api/books/{book_id}/bookmarks/{bid}",
                     json={"name": "renamed"})
    assert r.status_code == 200
    assert r.json()["id"] == bid and r.json()["created_at"] == created_at
    rows = client.get(f"/api/books/{book_id}/bookmarks").json()
    assert [b["name"] for b in rows] == ["renamed"]
    assert client.patch(f"/api/books/{book_id}/bookmarks/zzz",
                        json={"name": "x"}).status_code == 404
    assert client.patch("/api/books/zzz/bookmarks/zzz",
                        json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/books/{book_id}/bookmarks/{bid}").status_code == 200
    assert client.get(f"/api/books/{book_id}/bookmarks").json() == []


def test_settings(client):
    s = client.get("/api/settings").json()
    assert s["voice"] == "af_heart" and s["theme"] == "sepia"
    client.put("/api/settings", json={"theme": "dark"})
    assert client.get("/api/settings").json()["theme"] == "dark"


def test_audio_404_before_generation(client, book_id):
    assert client.get(f"/api/books/{book_id}/audio/section-000.mp3").status_code == 404
    assert client.get(f"/api/books/{book_id}/audio/recite.db").status_code == 400
    # A percent-encoded traversal never reaches the handler (starlette decodes
    # it pre-routing); either rejection status is fine, fetching the file is not.
    assert client.get(f"/api/books/{book_id}/audio/%2e%2e%2frecite.db").status_code in (400, 404)


def test_cover_404_when_absent(client, book_id):
    assert client.get(f"/api/books/{book_id}/cover").status_code == 404
    assert client.get("/api/books/zzz/cover").status_code == 404


def test_add_sample(client, monkeypatch):
    from app.api import books as books_api

    calls = []

    def fake_ingest(path):
        calls.append(path)
        return db.add_book("sample1", path, "Sample", "Anon", "epub", [], 42)

    monkeypatch.setattr(books_api, "ingest_file", fake_ingest)
    r = client.post("/api/books/sample")
    assert r.status_code == 200
    assert r.json()["already_present"] is False
    assert calls and calls[0].endswith("sample-library/sample.epub")
    # idempotent: the stable destination path dedupes to the same book
    r2 = client.post("/api/books/sample")
    assert r2.json()["already_present"] is True
    assert r2.json()["book"]["id"] == "sample1"


def test_status_404_without_manifest(client, book_id):
    assert client.get(f"/api/books/{book_id}/status").status_code == 404


def test_delete_book(client, book_id):
    assert client.delete(f"/api/books/{book_id}").status_code == 200
    assert db.get_book(book_id) is None

"""End-to-end ingest: db row, document.json, manifest.json, refusals."""
import json
import os
import tempfile

import fix
from app.db import db
from app.ingest.service import IngestError, content_hash, ingest_file


def _book_json(env, book_id, name):
    from app import config
    return json.loads(config.book_file(book_id, name).read_text("utf-8"))


def test_ingest_pdf_end_to_end():
    with fix.temp_data() as env:
        tmp = tempfile.TemporaryDirectory(prefix="recite-ing-")
        path = os.path.join(tmp.name, "two_col.pdf")
        fix.write_two_column_pdf(path)
        book = ingest_file(path)
        assert len(book["id"]) == 12
        assert book["format"] == "pdf"
        assert book["total_words"] > 200
        # db stores warnings as JSON text (the API layer decodes them)
        assert isinstance(json.loads(book["warnings"] or "[]"), list)
        doc = _book_json(env, book["id"], "document.json")
        assert set(doc) == {"id", "title", "author", "format", "source_path",
                            "content_hash", "warnings", "sections"}
        assert doc["id"] == book["id"]
        assert doc["content_hash"].startswith("sha256:")
        assert len(doc["sections"]) == 3
        manifest = _book_json(env, book["id"], "manifest.json")
        assert manifest["engine"] == "kokoro-0.9.4"
        assert manifest["voice"] == "af_heart"
        assert [s["idx"] for s in manifest["sections"]] == [0, 1, 2]
        assert all(s["status"] == "pending" for s in manifest["sections"])
        assert manifest["sections"][0]["audio"] == "audio/section-000.mp3"
        chunk = manifest["sections"][0]["chunks"][0]
        assert chunk["status"] == "pending" and chunk["words"] is None
        assert chunk["sentence_range"][0] <= chunk["sentence_range"][1]
        assert db.list_books()[0]["id"] == book["id"]


def test_ingest_epub_metadata_and_format():
    with fix.temp_data() as env:
        tmp = tempfile.TemporaryDirectory(prefix="recite-ing-")
        path = os.path.join(tmp.name, "book.epub")
        fix.write_epub(path)
        book = ingest_file(path)
        assert book["format"] == "epub"
        assert book["title"] == "The Quill And The Lantern"
        assert book["author"] == "J. Ashgrove"
        manifest = _book_json(env, book["id"], "manifest.json")
        assert [s["title"] for s in manifest["sections"]] == \
            ["Contents", "Chapter One", "Chapter Two"]


def test_voice_comes_from_settings():
    with fix.temp_data() as env:
        db.set_settings({"voice": "hf HANA"})
        tmp = tempfile.TemporaryDirectory(prefix="recite-ing-")
        path = fix.write_heading_pdf(os.path.join(tmp.name, "h.pdf"))
        book = ingest_file(path)
        manifest = _book_json(env, book["id"], "manifest.json")
        assert manifest["voice"] == "hf HANA"


def test_image_heavy_refusal_leaves_no_trace():
    with fix.temp_data() as env:
        tmp = tempfile.TemporaryDirectory(prefix="recite-ing-")
        path = os.path.join(tmp.name, "plates.pdf")
        fix.write_image_only_pdf(path)
        try:
            ingest_file(path)
        except IngestError as exc:
            assert "image-heavy" in str(exc)
            assert exc.warnings
        else:
            raise AssertionError("image-heavy pdf must be refused")
        assert db.list_books() == []


def test_unsupported_extension_refused():
    with fix.temp_data():
        tmp = tempfile.TemporaryDirectory(prefix="recite-ing-")
        path = fix.write_unsupported(os.path.join(tmp.name, "notes.txt"))
        try:
            ingest_file(path)
        except IngestError as exc:
            assert "unsupported" in str(exc)
        else:
            raise AssertionError(".txt must be refused")
        assert db.list_books() == []


def test_missing_file_refused():
    with fix.temp_data():
        try:
            ingest_file("/does/not/exist.pdf")
        except IngestError as exc:
            assert "not found" in str(exc)
        else:
            raise AssertionError("missing file must be refused")


def test_reingest_is_idempotent_and_deterministic():
    with fix.temp_data() as env:
        tmp = tempfile.TemporaryDirectory(prefix="recite-ing-")
        path = fix.write_two_column_pdf(os.path.join(tmp.name, "two_col.pdf"))
        first = ingest_file(path)
        manifest_a = _book_json(env, first["id"], "manifest.json")
        second = ingest_file(path)
        assert second["id"] == first["id"]
        assert len(db.list_books()) == 1
        manifest_b = _book_json(env, second["id"], "manifest.json")
        for a, b in zip(manifest_a["sections"], manifest_b["sections"]):
            assert [c["text"] for c in a["chunks"]] == \
                   [c["text"] for c in b["chunks"]]


def test_source_file_never_written():
    with fix.temp_data():
        tmp = tempfile.TemporaryDirectory(prefix="recite-ing-")
        path = fix.write_epub(os.path.join(tmp.name, "book.epub"))
        digest = content_hash(path)
        ingest_file(path)
        assert content_hash(path) == digest
        assert os.listdir(tmp.name) == ["book.epub"]


def test_ingest_writes_pdf_cover():
    with fix.temp_data() as env:
        tmp = tempfile.TemporaryDirectory(prefix="recite-ing-")
        path = fix.write_two_column_pdf(os.path.join(tmp.name, "two_col.pdf"))
        book = ingest_file(path)
        cover = env.root / "books" / book["id"] / "cover.jpg"
        assert cover.is_file()
        payload = cover.read_bytes()
        assert payload[:3] == b"\xff\xd8\xff"      # jpeg magic


def test_ingest_writes_epub_cover():
    with fix.temp_data() as env:
        tmp = tempfile.TemporaryDirectory(prefix="recite-ing-")
        path = fix.write_epub(os.path.join(tmp.name, "book.epub"))
        book = ingest_file(path)
        cover = env.root / "books" / book["id"] / "cover.png"
        assert cover.is_file()
        assert cover.read_bytes()[:4] == b"\x89PNG"  # png magic


def test_ingest_coverless_epub_writes_no_cover():
    with fix.temp_data() as env:
        tmp = tempfile.TemporaryDirectory(prefix="recite-ing-")
        path = fix.write_small_docs_epub(os.path.join(tmp.name, "harbor.epub"))
        book = ingest_file(path)
        bdir = env.root / "books" / book["id"]
        assert not any(bdir.glob("cover.*"))

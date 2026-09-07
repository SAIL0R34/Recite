"""EPUB extraction: container/OPF walking, headings as sections, refusals."""
import os
import tempfile

import fix
from app.ingest import epub
from app.ingest.service import IngestError


def _in_dir(name):
    tmp = tempfile.TemporaryDirectory(prefix="recite-epub-")
    return tmp, os.path.join(tmp.name, name)


def test_metadata_from_opf():
    tmp, path = _in_dir("book.epub")
    with tmp:
        fix.write_epub(path)
        ex = epub.extract(path)
        assert ex.title == "The Quill And The Lantern"
        assert ex.author == "J. Ashgrove"


def test_sections_come_from_headings():
    tmp, path = _in_dir("book.epub")
    with tmp:
        fix.write_epub(path)
        ex = epub.extract(path)
        titles = [s.title for s in ex.sections]
        assert titles == ["Contents", "Chapter One", "Chapter Two"]
        ch1 = ex.sections[1]
        # two paragraphs, two list items, one closing paragraph
        assert len(ch1.paragraphs) == 5
        assert ch1.paragraphs[0].anchor == "chapter-one"
        assert any(p.text.startswith("First note") for p in ch1.paragraphs)


def test_page_provenance_is_spine_ordinal():
    tmp, path = _in_dir("book.epub")
    with tmp:
        fix.write_epub(path)
        ex = epub.extract(path)
        pages = {s.title: {p.page for p in s.paragraphs} for s in ex.sections}
        assert pages["Contents"] == {1}
        assert pages["Chapter One"] == {2}
        assert pages["Chapter Two"] == {3}


def test_images_are_not_prose():
    tmp, path = _in_dir("book.epub")
    with tmp:
        fix.write_epub(path)
        ex = epub.extract(path)
        joined = " ".join(p.text for s in ex.sections for p in s.paragraphs)
        assert "plate1.png" not in joined
        assert "<img" not in joined


def test_image_only_epub_is_refused():
    tmp, path = _in_dir("plates.epub")
    with tmp:
        fix.write_image_only_epub(path)
        try:
            epub.extract(path)
        except IngestError as exc:
            assert "image-heavy" in str(exc)
            assert getattr(exc, "warnings", None)
        else:
            raise AssertionError("image-only epub must raise IngestError")


def test_source_file_untouched():
    tmp, path = _in_dir("untouched.epub")
    with tmp:
        fix.write_epub(path)
        before = (os.path.getmtime(path), os.path.getsize(path))
        epub.extract(path)
        assert (os.path.getmtime(path), os.path.getsize(path)) == before

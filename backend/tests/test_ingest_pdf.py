"""PDF extraction: sections, chrome, columns, hyphenation, refusals."""
import os
import tempfile

import fix
from app.ingest import pdf
from app.ingest.chunker import FORMULA_MARKER
from app.ingest.service import IngestError


def _in_dir(name):
    tmp = tempfile.TemporaryDirectory(prefix="recite-pdf-")
    return tmp, os.path.join(tmp.name, name)


def _para_texts(extraction):
    return [p.text for s in extraction.sections for p in s.paragraphs]


def test_two_column_sections_and_order():
    tmp, path = _in_dir("two_col.pdf")
    with tmp:
        fix.write_two_column_pdf(path)
        ex = pdf.extract(path)
        titles = [s.title for s in ex.sections]
        assert titles == ["Chapter One", "Chapter Two", "Chapter Three"]
        texts = _para_texts(ex)
        assert 11 <= len(texts) <= 13
        for entry in fix.PROSE:
            assert fix.prose_text(entry) in texts
        # column-first reading order: Bravo follows Alpha inside page 1
        keys = [text.split(".", 1)[0] for text in texts]
        assert keys[:2] == ["Alpha", "Bravo"]


def test_chrome_is_stripped():
    tmp, path = _in_dir("chrome.pdf")
    with tmp:
        fix.write_two_column_pdf(path)
        ex = pdf.extract(path)
        joined = " ".join(_para_texts(ex))
        assert fix.HEADER not in joined
        assert fix.FOOTER not in joined
        assert " Recitation " not in joined          # no stray footer fragment
        assert " 5 " not in joined                   # bare page numbers gone
        assert any("chrome" in w or "header" in w or "footer" in w
                   for w in ex.warnings) or ex.warnings == []


def test_page_provenance():
    tmp, path = _in_dir("provenance.pdf")
    with tmp:
        fix.write_two_column_pdf(path)
        ex = pdf.extract(path)
        by_marker = {text.split(".", 1)[0]: p
                     for s in ex.sections for p in s.paragraphs
                     for text in [p.text]}
        assert by_marker["Alpha"].page == 1
        assert by_marker["Charlie"].page == 2
        assert by_marker["Kilo"].page == 6


def test_heading_size_sections_without_toc():
    tmp, path = _in_dir("headings.pdf")
    with tmp:
        fix.write_heading_pdf(path)
        ex = pdf.extract(path)
        assert [s.title for s in ex.sections] == fix.HEAD_TITLES
        assert all(s.paragraphs for s in ex.sections)


def test_hyphenation_rejoined():
    tmp, path = _in_dir("hyphen.pdf")
    with tmp:
        fix.write_hyphen_pdf(path)
        ex = pdf.extract(path)
        texts = _para_texts(ex)
        assert fix.HYPHEN_EXPECT[0] in texts
        assert fix.HYPHEN_EXPECT[1] in texts      # includes the page-span hyphen
        joined = " ".join(texts)
        assert "they- selves" not in joined
        assert "hap- pening" not in joined


def test_formula_paragraphs_flagged():
    tmp, path = _in_dir("formula.pdf")
    with tmp:
        fix.write_formula_pdf(path)
        ex = pdf.extract(path)
        paras = [p for s in ex.sections for p in s.paragraphs]
        flagged = [p for p in paras if p.no_tts]
        assert flagged
        assert all(p.text == FORMULA_MARKER for p in flagged)
        spoken = [p.text for p in paras if not p.no_tts]
        assert not any("def ratio" in t for t in spoken)
        assert any("Normal prose paragraph" in t for t in spoken)


def test_image_only_pdf_is_refused():
    tmp, path = _in_dir("plates.pdf")
    with tmp:
        fix.write_image_only_pdf(path)
        try:
            pdf.extract(path)
        except IngestError as exc:
            assert "image-heavy" in str(exc)
            assert "skipped pages" in str(exc)
            assert getattr(exc, "warnings", None)
        else:
            raise AssertionError("image-only pdf must raise IngestError")


def test_source_file_untouched():
    tmp, path = _in_dir("untouched.pdf")
    with tmp:
        fix.write_two_column_pdf(path)
        before = (os.path.getmtime(path), os.path.getsize(path))
        pdf.extract(path)
        assert (os.path.getmtime(path), os.path.getsize(path)) == before

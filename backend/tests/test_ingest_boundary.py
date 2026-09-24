"""The image-heavy decision boundary, pinned in one table.

Every archetype a real library produces — scanned plates, magazine
caption/headline layouts, produced EPUBs with tiny front documents — is
represented by a deterministic fixture (fix.py). Each row pins whether the
ingest service must refuse or accept it, so a boundary regression fails with
the whole matrix in view.
"""
import os
import tempfile

import pytest

import fix
from app.db import db
from app.ingest.service import IngestError, ingest_file

# (fixture writer, filename, refused?)
BOUNDARY = [
    (fix.write_image_only_pdf, "plates.pdf", True),     # scanned, no text
    (fix.write_caption_pdf, "captions.pdf", True),      # isolated fragments
    (fix.write_headline_pdf, "headlines.pdf", True),    # magazine layout
    (fix.write_image_only_epub, "plates.epub", True),   # every doc a plate
    (fix.write_two_column_pdf, "two_col.pdf", False),   # dense two-column
    (fix.write_heading_pdf, "headings.pdf", False),     # TOC-less textbook
    (fix.write_epub, "book.epub", False),               # hand-built EPUB
    (fix.write_small_docs_epub, "harbor.epub", False),  # tiny front docs
]


@pytest.mark.parametrize("write,filename,refused", BOUNDARY,
                         ids=[row[1] for row in BOUNDARY])
def test_image_heavy_decision_boundary(write, filename, refused):
    with fix.temp_data():
        tmp = tempfile.TemporaryDirectory(prefix="recite-boundary-")
        path = write(os.path.join(tmp.name, filename))
        if refused:
            try:
                ingest_file(path)
            except IngestError as exc:
                assert str(exc).startswith("image-heavy")
                assert exc.warnings
            else:
                raise AssertionError(f"{filename} must be refused")
        else:
            book = ingest_file(path)
            assert book["total_words"] > 0
        # refusals leave no trace; accepts leave exactly one book
        assert len(db.list_books()) == (0 if refused else 1)

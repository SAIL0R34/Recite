"""Test fixtures: PDFs drawn with PyMuPDF and hand-built EPUBs.

Deterministic and generated at test time; no real library book is opened by
the suite (there is a separate smoke script for those).
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Dict, List

import pymupdf

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

PAGE_W, PAGE_H = 600, 800
HEADER = "Two Column Test Bench"
FOOTER = "Recitation Volume Twelve"
TOC = ("Chapter One", "Chapter Two", "Chapter Three")
COL_X = (60, 320)
COL_W = 230

PROSE: List[dict] = [
    {
        "page": 1, "col": 0, "key": "Alpha",
        "text": "The quick brown fox runs across the meadow and keeps running "
                "through the fields of a long summer morning without any worry.",
    },
    {
        "page": 1, "col": 1, "key": "Bravo",
        "text": "Reading along while listening needs precise timing, otherwise "
                "the highlight drifts away from the spoken word and the "
                "illusion dies.",
    },
    {
        "page": 2, "col": 0, "key": "Charlie",
        "text": "Chapters are natural audio boundaries, so one file per "
                "chapter keeps seeking instant and buffering small on any "
                "modest laptop or phone.",
    },
    {
        "page": 2, "col": 1, "key": "Delta",
        "text": "A generated voice reads the sentence and the following words "
                "appear highlighted one by one as the audio rolls steadily "
                "onward.",
    },
    {
        "page": 3, "col": 0, "key": "Echo",
        "text": "Markers such etc were treated carefully by the splitter, "
                "since an abbreviation like Vol. 3 must never end a sentence "
                "by mistake here.",
    },
    {
        "page": 3, "col": 1, "key": "Foxtrot",
        "text": "Everything a reader needs lives in one document, including "
                "page numbers from the original file, so provenance is never "
                "lost at all.",
    },
    {
        "page": 4, "col": 0, "key": "Golf",
        "text": "Bookmarks point at a section and an offset, which makes "
                "jumping back to a difficult passage quick and completely "
                "reliable for readers.",
    },
    {
        "page": 4, "col": 1, "key": "Hotel",
        "text": "Progress is stored as a position and a percentage, so "
                "reopening a book resumes at the exact word where the reader "
                "stopped before.",
    },
    {
        "page": 5, "col": 0, "key": "India",
        "text": "When the text is dense the chunker keeps chunks small, "
                "because a short chunk boundary is far easier to align than "
                "one huge block.",
    },
    {
        "page": 5, "col": 1, "key": "Juliet",
        "text": "Typography settings belong to the reader and not to the "
                "book, so themes and font sizes may change freely between two "
                "reading trips.",
    },
    {
        "page": 6, "col": 0, "key": "Kilo",
        "text": "Finally the last chapter closes the argument with a modest "
                "conclusion and a short paragraph about listening while "
                "reading too.",
    },
    {
        "page": 6, "col": 1, "key": "Lima",
        "text": "Nothing after this paragraph belongs to the body text of the "
                "sample book used by the ingest tests, and that is perfectly "
                "acceptable.",
    },
]

TOC_PAGES = {1: TOC[0], 3: TOC[1], 5: TOC[2]}


def prose_text(entry: dict) -> str:
    """The exact paragraph text the extractor should recover for `entry`."""
    return f"{entry['key']}. {entry['text']}"


def _box(col: int, top: int) -> "pymupdf.Rect":
    return pymupdf.Rect(COL_X[col], top, COL_X[col] + COL_W, top + 150)


def write_two_column_pdf(path: str) -> str:
    """6-page two-column book, real TOC, repeating header/footer chrome."""
    doc = pymupdf.open()
    by_page: Dict[int, list] = {}
    for entry in PROSE:
        by_page.setdefault(entry["page"], []).append(entry)
    for page in sorted(by_page):
        p = doc.new_page(width=PAGE_W, height=PAGE_H)
        p.insert_text((20, 40), HEADER, fontsize=9)
        p.insert_text((20, PAGE_H - 25), FOOTER, fontsize=9)
        p.insert_text((PAGE_W - 60, PAGE_H - 25), str(page), fontsize=9)
        for entry in sorted(by_page[page], key=lambda e: (e["col"], e["key"])):
            p.insert_textbox(
                _box(entry["col"], 100),
                f"{entry['key']}. {entry['text']}",
                fontsize=10,
            )
    doc.set_toc([[1, TOC_PAGES[page], page] for page in sorted(TOC_PAGES)])
    doc.save(path)
    doc.close()
    return path


def write_image_only_pdf(path: str) -> str:
    """Draw-only pages: zero extracted text, so ingest must refuse."""
    doc = pymupdf.open()
    for _i in range(4):
        p = doc.new_page(width=PAGE_W, height=PAGE_H)
        sh = p.new_shape()
        sh.draw_rect(pymupdf.Rect(40, 40, PAGE_W - 40, PAGE_H - 40))
        sh.finish(color=(0.1, 0.1, 0.1), fill=(0.85, 0.8, 0.6))
        sh.draw_rect(pymupdf.Rect(120, 160, 420, 520))
        sh.finish(fill=(0.2, 0.4, 0.7))
        sh.commit()
    doc.save(path)
    doc.close()
    return path


HYPHEN_PAGES = (
    (
        ("It turned out that them-", 0),
        ("selves had no idea what was hap-", 18),
        ("pening at all.", 18),
        ("It also helps to know that this ordinary sentence keeps the page well", 46),
        ("above the image-heavy character threshold used by the extractor. Read", 18),
        ("it twice if you doubt that a plain sentence can carry real estate.", 18),
        ("The layout was com-", 48),
    ),
    (
        ("piled for this test, which is how a break should never be noticed.", 0),
        ("A final unhyphenated sentence on this page supplies plain prose so that", 48),
        ("the fixture stays comfortably above the threshold that the extractor", 18),
        ("enforces on average across all of its pages today. No hyphens here.", 18),
    ),
)

HYPHEN_EXPECT = (
    "It turned out that themselves had no idea what was happening at all.",
    "The layout was compiled for this test, which is how a break should never be noticed.",
)


def write_hyphen_pdf(path: str) -> str:
    """Hand-placed lines: hyphenated line breaks and one page-spanning hyphen."""
    doc = pymupdf.open()
    for paragraphs in HYPHEN_PAGES:
        p = doc.new_page(width=PAGE_W, height=PAGE_H)
        y = 120
        for text, gap in paragraphs:
            y += gap
            p.insert_text((70, y), text, fontsize=11)
    doc.save(path)
    doc.close()
    return path


HEAD_TITLES = list(TOC)
HEAD_BODY = (
    "The rain falls mainly on the plain and the attentive reader keeps up "
    "easily, chapter after chapter, without losing the thread of the argument "
    "anywhere.",
    "Second paragraph of the first chapter, which contains a plain sentence "
    "only, written to keep this fixture comfortably above the image-heavy "
    "threshold.",
    "Chapter two opens with a body paragraph written in the ordinary font of "
    "the press, and it rambles on a little so that the extractor has work to "
    "do.",
    "The final paragraph closes the fixture with one last plain declarative "
    "line, after which the reader may rest, reflect, and close the cover of "
    "the book.",
    "The third chapter opens with its own plain paragraph, set in the "
    "ordinary body font, so that even the last page of this fixture carries "
    "real prose for the extractor to recover.",
    "A closing sentence follows it, modest and unadorned, keeping this page "
    "comfortably above the image-heavy character threshold that the ingest "
    "layer enforces on every document it reads.",
)


def write_heading_pdf(path: str) -> str:
    """No TOC at all: section titles are lone lines set in a larger font."""
    doc = pymupdf.open()
    for i, title in enumerate(HEAD_TITLES):
        p = doc.new_page(width=PAGE_W, height=PAGE_H)
        p.insert_text((70, 110), title, fontsize=18, fontname="hebo")
        y = 170
        for body in HEAD_BODY[i * 2:i * 2 + 2]:
            p.insert_textbox(pymupdf.Rect(70, y, 520, y + 120), body,
                             fontsize=10)
            y += 190
    doc.save(path)
    doc.close()
    return path


CODE_BLOCK = "def ratio(a, b):  return float(a) / float(b) if b else 0.0"
FORMULA_PROSE = ("Normal prose paragraph number one on this page of the "
                 "formula fixture, written in the ordinary body font for the "
                 "reader.")


def write_formula_pdf(path: str) -> str:
    """Prose plus a monospace block: the code paragraph must be flagged no_tts."""
    doc = pymupdf.open()
    for _pno in range(2):
        p = doc.new_page(width=PAGE_W, height=PAGE_H)
        p.insert_textbox(pymupdf.Rect(70, 100, 520, 200), FORMULA_PROSE, fontsize=10)
        p.insert_textbox(
            pymupdf.Rect(70, 320, 520, 380),
            CODE_BLOCK,
            fontsize=10,
            fontname="cour",
        )
        p.insert_textbox(
            pymupdf.Rect(70, 470, 520, 560),
            "Another ordinary paragraph after the code block, which must "
            "survive the formula flag untouched and speakable.",
            fontsize=10,
        )
    doc.save(path)
    doc.close()
    return path


EPUB_CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
     media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

EPUB_OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">recite-fixture-epub</dc:identifier>
    <dc:title>The Quill And The Lantern</dc:title>
    <dc:creator>J. Ashgrove</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="cover-image" href="Images/cover.png" media-type="image/png"
           properties="cover-image"/>
    <item id="toc" href="Text/toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="toc"/><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>
"""

# 1x1 transparent PNG — a deterministic cover image for the fixture EPUB.
TINY_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d4944415478da63f8ffff3f0005fe02fea735c9a4"
    "0000000049454e44ae426082"
)

EPUB_TOC = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html><head><title>Contents</title></head>
<body>
<h1>Contents</h1>
<p>A decorative plate sits here and the image beside it carries no prose at all,
yet the caption below it still describes the engraving in some detail for the
reader.</p>
</body></html>
"""

EPUB_CH1 = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html><head><title>One</title></head>
<body>
<h2 id="chapter-one">Chapter One</h2>
<p>The lantern sat on the sill and the quill lay beside it, waiting for a hand.</p>
<p>Nothing moved in the room for a while, except the dust moving slowly in the
lamplight and the clock keeping its patient time on the mantel.</p>
<ul><li>First note about the fixture.</li><li>Second note about the fixture.</li></ul>
<p>She counted the pages twice, then began to read aloud in a very low voice,
the way she had done every evening since the winter began.</p>
</body></html>
"""

EPUB_CH2 = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html><head><title>Two</title></head>
<body>
<h2 id="chapter-two">Chapter Two</h2>
<p>Later the wind came up and the lantern went out, but the reading did not
stop, because the words had already been learned by heart long before.</p>
<p>By morning the whole chapter had been read, and the quill was used up
entirely, so she sharpened a fresh one and set down to answer the letters.</p>
</body></html>
"""

EPUB_PLATES = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html><head><title>plates</title></head>
<body>
<div class="plate"><img src="plate1.png" alt="plate one"/></div>
<div class="plate"><img src="plate2.png" alt="plate two"/></div>
</body></html>
"""


def _zip_epub(path: str, docs: List[str]) -> str:
    with zipfile.ZipFile(path, "w") as z:
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        z.writestr(info, "application/epub+zip")
        z.writestr("META-INF/container.xml", EPUB_CONTAINER)
        z.writestr("OEBPS/content.opf", EPUB_OPF)
        z.writestr("OEBPS/Images/cover.png", TINY_PNG)
        for name in docs:
            z.writestr(
                f"OEBPS/Text/{name}.xhtml",
                dict(toc=EPUB_TOC, ch1=EPUB_CH1, ch2=EPUB_CH2,
                     plates=EPUB_PLATES)[name],
            )
    return path


def write_epub(path: str) -> str:
    """A 3-document EPUB assembled by hand (mimetype stored first)."""
    return _zip_epub(path, ["toc", "ch1", "ch2"])


def write_image_only_epub(path: str) -> str:
    """Every spine document is an image plate -> must be refused."""
    return _zip_epub(path, ["plates", "plates", "plates"])


# ------------------------------------------------- refusal fixtures: layout

CAPTION_LINES = (
    "Terraces cascade toward a private garden reserved for residents.",
    "The atrium doubles as a gallery for commissioned light works.",
    "A lacquered stair anchors the hall beneath a woven pendant.",
    "Kitchen islands give way to worktops of honed basalt stone.",
    "Framed prints keep the reading corner quiet and uncluttered.",
    "Sunlight pools on terrazzo floors through arched bay windows.",
    "A single lounge chair sets the tone for the entire mezzanine.",
    "Courtyard planters borrow their palette from the coastal bed.",
    "Millwork hides every appliance behind seamless walnut panels.",
    "Stair balusters repeat at a rhythm borrowed from the facade.",
    "Brass fixtures warm the otherwise monochrome gallery bath.",
    "A reading ledge faces the water beneath deep window reveals.",
)

HEADLINES = (
    "Staircases That Steal the Show",
    "Inside the Glass Courtyard House",
    "A Kitchen Rebuilt Around Light",
    "The Quiet Radicalism of Plain Rooms",
    "Six Rooms That Redefine the Hallway",
    "Where Stone Meets Water on the Coast",
    "A Library Carved From Old Timber",
    "The Terrace Season Begins Early",
    "Hand-Thrown Tile Finds Its Moment",
    "Two Windows and a Very Long Table",
    "The Corridor as a Picture Frame",
    "Rooflines Broken Up by Dormers",
    "A Garden Held Behind Low Walls",
    "The Return of the Painted Ceiling",
)

DECK = ("Decks and captions carry this month's tours in condensed form,",
        "while the feature itself lives entirely inside the photography.")


def write_caption_pdf(path: str) -> str:
    """12 pages of isolated caption fragments: high enough average, no prose."""
    doc = pymupdf.open()
    for page in range(12):
        p = doc.new_page(width=PAGE_W, height=PAGE_H)
        for i in range(6):
            line = CAPTION_LINES[(page * 6 + i) % len(CAPTION_LINES)]
            p.insert_text((70, 120 + i * 90), line, fontsize=11)
    doc.save(path)
    doc.close()
    return path


def write_headline_pdf(path: str) -> str:
    """14 magazine-layout pages: headline, deck, caption, credit only."""
    doc = pymupdf.open()
    for page in range(14):
        p = doc.new_page(width=PAGE_W, height=PAGE_H)
        p.insert_text((60, 140), HEADLINES[page % len(HEADLINES)], fontsize=22)
        p.insert_text((60, 300), DECK, fontsize=12)
        p.insert_text((60, 322), CAPTION_LINES[page % len(CAPTION_LINES)],
                      fontsize=12)
        p.insert_text((60, 470), DECK[:52], fontsize=10)
        p.insert_text((60, 492), CAPTION_LINES[(page + 5) % len(CAPTION_LINES)],
                      fontsize=10)
        p.insert_text((60, 700), "Photograph by A. Studio, issue twelve",
                      fontsize=9)
    doc.save(path)
    doc.close()
    return path


# --------------------------------------------- EPUB with tiny front docs

SMALLDOCS_OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">recite-fixture-smalldocs</dc:identifier>
    <dc:title>Small Harbor</dc:title>
    <dc:creator>Ada Mireille</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="colophon" href="Text/colophon.xhtml" media-type="application/xhtml+xml"/>
    <item id="toc" href="Text/toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="cover"/><itemref idref="colophon"/>
         <itemref idref="toc"/><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>
"""

SMALLDOCS_COVER = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html><head><title>Cover</title></head>
<body>
<div class="titleblock">
<h1>Small Harbor</h1>
<div class="author">Ada Mireille</div>
</div>
</body></html>
"""

SMALLDOCS_COLOPHON = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html><head><title>Colophon</title></head>
<body>
<div class="plate"><img src="plate.png" alt="printer's device"/></div>
</body></html>
"""

SMALLDOCS_TOC = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html><head><title>Contents</title></head>
<body>
<h1>Contents</h1>
<p>Two chapters and a short harbor, nothing more.</p>
</body></html>
"""

SMALLDOCS_CH1 = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html><head><title>One</title></head>
<body>
<h2 id="chapter-one">Chapter One</h2>
<div class="s18">The harbor master kept his ledger in a drawer that smelled of
salt and cedar, and every autumn he rewrote the same three pages about the
storm that took the lightship off the point.</div>
<div class="s18">Boats came in on the tide and went out on it again, and the
water never once kept what the town entrusted to it, which the gulls seemed to
find very funny and the dogs not at all.</div>
<div class="s18">She learned the names of the moored boats before her name was
properly known, and by the first frost she could tell the season by the ropes
alone, stiff or soft according to the month.</div>
</body></html>
"""

SMALLDOCS_CH2 = """<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html><head><title>Two</title></head>
<body>
<h2 id="chapter-two">Chapter Two</h2>
<div class="s18">Winter closed the cafe and opened the wind, so the street
learned to walk indoors, and the library took the whole town into its two warm
rooms without ever mentioning the number of coats.</div>
<div class="s18">When spring returned the harbor master found a fourth page
waiting in his drawer, written in a hand he did not know, describing a storm
that had not happened yet.</div>
</body></html>
"""

_SMALPDOCS = {
    "cover": SMALLDOCS_COVER, "colophon": SMALLDOCS_COLOPHON,
    "toc": SMALLDOCS_TOC, "ch1": SMALLDOCS_CH1, "ch2": SMALLDOCS_CH2,
}


def write_small_docs_epub(path: str) -> str:
    """Text-less colophon plus tiny cover/contents around real chapters.

    Prose is marked up as leaf <div>s (common in produced EPUBs), and the
    book-wide text floor must not be diluted by the small front documents.
    """
    with zipfile.ZipFile(path, "w") as z:
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        z.writestr(info, "application/epub+zip")
        z.writestr("META-INF/container.xml", EPUB_CONTAINER)
        z.writestr("OEBPS/content.opf", SMALLDOCS_OPF)
        for name, html in _SMALPDOCS.items():
            z.writestr(f"OEBPS/Text/{name}.xhtml", html)
    return path


def write_unsupported(path: str) -> str:
    Path(path).write_text("not a book")
    return path


class TempEnv:
    """A throwaway Recite data dir, and readers for its per-book json."""

    def __init__(self, root):
        self.root = Path(root)

    def _json(self, book_id: str, name: str) -> dict:
        from app import config
        return json.loads(config.book_file(book_id, name).read_text("utf-8"))

    def document(self, book_id: str) -> dict:
        return self._json(book_id, "document.json")

    def manifest(self, book_id: str) -> dict:
        return self._json(book_id, "manifest.json")


class temp_data:
    """Context manager that repoints config + the db singleton at a temp dir.

    Written as a plain context manager (not a pytest fixture) so the suite can
    also be driven by a stdlib runner when pytest is unavailable.
    """

    def __enter__(self):
        from app import config
        from app.db import db
        self._dir = tempfile.TemporaryDirectory(prefix="recite-test-")
        root = Path(self._dir.name)
        self._saved = {k: getattr(config, k) for k in
                       ("DATA_DIR", "BOOKS_DIR_PATH", "DB_PATH")}
        config.DATA_DIR = root
        config.BOOKS_DIR_PATH = root / "books"
        config.DB_PATH = root / "recite.db"
        if db._conn is not None:
            try:
                db._conn.close()
            except Exception:
                pass
            db._conn = None
        db.path = config.DB_PATH
        db.init()
        return TempEnv(root)

    def __exit__(self, *exc):
        from app import config
        from app.db import db
        if db._conn is not None:
            try:
                db._conn.close()
            except Exception:
                pass
            db._conn = None
        for k, v in self._saved.items():
            setattr(config, k, v)
        shutil.rmtree(self._dir.name, ignore_errors=True)
        return False

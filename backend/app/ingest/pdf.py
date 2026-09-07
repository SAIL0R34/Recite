"""PDF extraction with PyMuPDF.

Pipeline::

    pages -> sorted blocks (spec: `blocks`, sort=True) -> lines with geometry
            -> header/footer strip -> column-aware reading order
            -> paragraph grouping (gap analysis)
            -> formula/code flagging
            -> sections (TOC pages, else font-size headings, else one untitled)

Every paragraph keeps its source page. Refusals raise ``IngestError`` (see
service): image-heavy documents, or documents with no readable text.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from statistics import median
from typing import Iterable, List, Optional, Sequence, Tuple

import pymupdf

from .chunker import (FORMULA_MARKER, is_formula_text, looks_like_code,
                      normalize_text, symbol_density)
from .model import Extraction, Paragraph, Section, paragraph_from_text

# --------------------------------------------------------------- parameters
HEADER_BAND = 0.08            # top/bottom fraction of a page treated as margin
HEADER_REPEAT_RATIO = 0.60    # margin text on >=60% of pages is page chrome
MIN_PAGES_FOR_CHROME = 3
GAP_FACTOR = 1.4              # vertical gap > 1.4 line-heights ends a paragraph
INDENT_FACTOR = 1.2           # x jump > 1.2 em starts a new paragraph
HEADING_SIZE_FACTOR = 1.3     # line size >= 1.3x median -> heading candidate
SHORT_LINE_RATIO = 0.85       # a paragraph ends on a line shorter than this
SPARSE_PAGE_CHARS = 20        # a page with fewer chars counts as image-only
IMAGE_HEAVY_MIN_CHARS = 200   # avg chars/page below this -> refuse
MEDIAN_PAGE_MIN = 600         # median page chars below this -> suspect
PARAGRAPH_BLOCK_CHARS = 600   # a layout block this long is paragraph-scale
PARAGRAPH_COVERAGE_MIN = 0.20 # share of text in paragraph-scale blocks
MIN_PAGES_FOR_SHAPE = 10      # shape rules judge books of at least this size
FORMULA_DENSITY = 0.25        # >25% math symbols -> formula
MONO_RATIO = 0.60             # >60% monospaced chars -> code
SENTENCE_FINAL = ".!?"
_TRAILERS = "\"'\u201d\u2019)]"

_PAGE_NUMBER = re.compile(
    r"""^\s*(?:page[.\s]*)?[\d]{1,4}(?:\s*/\s*\d+)?|[-\u2013\u2014]?\s*[\d]{1,4}\s*[-\u2013\u2014]|[ivxlcdmIVXLCDM]{1,7}\.?\s*$
    """, re.VERBOSE)
_WORDS = re.compile(r"[^\W\d_]{2,}", re.U)


@dataclass
class _Line:
    """One text line plus the geometry paragraph grouping needs."""
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    mono_frac: float = 0.0
    blank: bool = False
    heading: bool = False

    @property
    def height(self) -> float:
        return max(self.y1 - self.y0, 1.0)

    @property
    def width(self) -> float:
        return max(self.x1 - self.x0, 0.0)

    @property
    def ends_sentence(self) -> bool:
        t = self.text.rstrip(_TRAILERS + " ")
        return bool(t) and t[-1] in SENTENCE_FINAL

    @property
    def starts_upper(self) -> bool:
        t = self.text.lstrip("\"'\u201c([\u00a3 ")
        return bool(t) and t[0].isupper()

    @property
    def stripped(self) -> str:
        return self.text.strip()


@dataclass
class _Page:
    number: int
    width: float
    height: float
    lines: List[_Line] = field(default_factory=list)
    chars: int = 0
    block_chars: List[int] = field(default_factory=list)

    def in_band(self, line: _Line) -> bool:
        band = self.height * HEADER_BAND
        return line.y0 < band or line.y1 > self.height - band


@dataclass
class _Para:
    """A paragraph before it becomes a document Paragraph."""
    page: int
    lines: List[_Line]
    text: str

    @property
    def mono_ratio(self) -> float:
        chars = sum(len(ln.text) for ln in self.lines)
        if not chars:
            return 0.0
        return sum(len(ln.text) * ln.mono_frac for ln in self.lines) / chars

    @property
    def is_formula(self) -> bool:
        return (symbol_density(self.text) > FORMULA_DENSITY
                or self.mono_ratio > MONO_RATIO
                or (looks_like_code(self.text) and self.mono_ratio > 0.30))


# ----------------------------------------------------------------- refusals

def _fail(message: str, warnings: Iterable[str] = ()) -> None:
    from .service import IngestError      # deferred: avoids an import cycle
    exc = IngestError(message)
    exc.warnings = list(warnings)         # type: ignore[attr-defined]
    raise exc


def _ranges(nums: Sequence[int]) -> str:
    """[1,2,3,7] -> '1\u20133, 7'."""
    nums = sorted(set(nums))
    out: List[str] = []
    i = 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(str(nums[i]) if i == j else f"{nums[i]}\u2013{nums[j]}")
        i = j + 1
    return ", ".join(out)


def _median(xs: Sequence[float]) -> float:
    vals = [x for x in xs if x]
    return float(median(vals)) if vals else 0.0


def _is_page_number(text: str) -> bool:
    text = text.strip()
    if not text or not _PAGE_NUMBER.match(text):
        return False
    return not _WORDS.search(text)


# --------------------------------------------------------------- page lines

def _block_lines(block: dict) -> List[_Line]:
    """Lines of a `blocks` entry, enriched from the matching `dict` block."""
    lines: List[_Line] = []
    db = block.get("dict") or {}
    for ln in db.get("lines", []):
        spans = ln.get("spans") or []
        text = "".join(s.get("text", "") for s in spans)
        chars = sum(len(s.get("text", "")) for s in spans)
        mono = sum(len(s.get("text", "")) for s in spans if _span_is_mono(s))
        x0, y0, x1, y1 = ln.get("bbox", (0.0, 0.0, 0.0, 0.0))
        sizes = [s.get("size", 0) for s in spans if s.get("size")]
        lines.append(_Line(text=text, x0=x0, y0=y0, x1=x1, y1=y1,
                           size=max(sizes) if sizes else 0.0,
                           mono_frac=(mono / chars) if chars else 0.0,
                           blank=not text.strip()))
    raw_lines = (block.get("text") or "").split("\n")
    if len(raw_lines) == len(lines):      # blank lines only survive as gaps
        for raw, ln in zip(raw_lines, lines):
            if not raw.strip():
                ln.blank = True
    return lines


def _span_is_mono(span: dict) -> bool:
    font = (span.get("font") or "").lower()
    return bool(span.get("flags", 0) & 8) or font in ("cour", "courier",
                                                      "couriernew", "sfmono-regular")


def _page_blocks(page) -> List[dict]:
    """Text blocks in reading order, with the parallel `dict` block attached."""
    try:
        blocks = [b for b in page.get_text("blocks", sort=True)
                  if len(b) >= 7 and b[6] == 0]
    except Exception:
        return []
    try:
        dblocks = [b for b in page.get_text("dict", sort=True).get("blocks", [])
                   if b.get("type") != 1]
    except Exception:
        dblocks = []
    out: List[dict] = []
    for i, b in enumerate(blocks):
        bbox = (float(b[0]), float(b[1]), float(b[2]), float(b[3]))
        out.append({"bbox": bbox, "text": b[4] or "", "dict": _match_block(bbox, dblocks, i)})
    return out


def _match_block(bbox: Tuple[float, float, float, float], dblocks: List[dict],
                 hint: int) -> Optional[dict]:
    """The `dict` block whose bbox matches a `blocks` entry (same sort order)."""
    if not dblocks:
        return None

    def close(other, tol: float = 2.0) -> bool:
        return all(abs(bbox[i] - other[i]) <= tol for i in range(4))

    if 0 <= hint < len(dblocks) and close(dblocks[hint]["bbox"]):
        return dblocks[hint]
    best, best_d = None, 1e9
    for db in dblocks:
        d = sum(abs(bbox[i] - db["bbox"][i]) for i in range(4))
        if d < best_d:
            best, best_d = db, d
    return best if best_d <= 5 else None


def _collect_pages(doc) -> List[_Page]:
    pages: List[_Page] = []
    for pno in range(doc.page_count):
        page = doc[pno]
        rect = page.rect
        pg = _Page(number=pno + 1, width=float(rect.width or 1),
                   height=float(rect.height or 1))
        lines: List[_Line] = []
        block_chars: List[int] = []
        for block in _page_blocks(page):
            blines = _block_lines(block)
            block_chars.append(sum(len(re.sub(r"\s+", "", ln.text))
                                   for ln in blines))
            lines.extend(blines)
        pg.lines = lines
        pg.block_chars = block_chars
        pg.chars = sum(len(re.sub(r"\s+", "", ln.text)) for ln in lines)
        pages.append(pg)
    return pages


def _check_extractable(pages: List[_Page]) -> List[str]:
    """Refuse image-heavy documents; return warnings for a readable one."""
    if not pages:
        _fail(_refusal_message("no pages"))
    total = sum(p.chars for p in pages)
    avg = total / len(pages)
    sparse = [p.number for p in pages if p.chars < SPARSE_PAGE_CHARS]
    if avg < IMAGE_HEAVY_MIN_CHARS:
        _fail(_refusal_message(_ranges(sparse) or "1"),
              [f"image-heavy: average {int(avg)} chars per page"])
    # A passing average can still hide a magazine: captions and ad copy are
    # short isolated lines that lift the mean, while real prose forms long
    # multi-line blocks. On books long enough for shape to mean something,
    # a low median page density combined with almost no paragraph-scale
    # blocks is an image-heavy layout.
    if len(pages) >= MIN_PAGES_FOR_SHAPE:
        med = median(p.chars for p in pages)
        big = sum(sum(c for c in p.block_chars if c >= PARAGRAPH_BLOCK_CHARS)
                  for p in pages)
        coverage = big / total if total else 0.0
        if med < MEDIAN_PAGE_MIN and coverage < PARAGRAPH_COVERAGE_MIN:
            weak = [p.number for p in pages if p.chars < MEDIAN_PAGE_MIN]
            _fail(_refusal_message(_ranges(weak) or "1"),
                  [f"image-heavy: median {int(med)} chars per page, "
                   f"{int(coverage * 100)}% of text in paragraph blocks"])
    warnings: List[str] = []
    if sparse and len(sparse) < len(pages):
        warnings.append(f"image-only pages skipped: {_ranges(sparse)}")
    return warnings


def _refusal_message(skipped: str, avg: float = 0.0) -> str:
    return (f"image-heavy document \u2014 no extractable text "
            f"(skipped pages {skipped})")


# ------------------------------------------------------- chrome (hdr/ftr)

def _strip_chrome(pages: List[_Page]) -> Tuple[List[str], List[str]]:
    """Strip margin text repeating across pages, plus bare page numbers.

    Returns (warnings, stripped_texts).
    """
    counts: Dict = {}
    for pg in pages:
        for ln in pg.lines:
            if ln.blank or not pg.in_band(ln):
                continue
            key = re.sub(r"\s+", " ", ln.text).strip().lower()
            if key:
                counts.setdefault(key, set()).add(pg.number)
    chrome: set = set()
    if len(pages) >= MIN_PAGES_FOR_CHROME:
        threshold = max(2, int(HEADER_REPEAT_RATIO * len(pages)))
        chrome = {k for k, seen in counts.items() if len(seen) >= threshold}

    stripped: List[str] = []
    kept: List[_Page] = []
    for pg in pages:
        out: List[_Line] = []
        for ln in pg.lines:
            if ln.blank:
                out.append(ln)
                continue
            text = ln.text.strip()
            if pg.in_band(ln) and (re.sub(r"\s+", " ", text).lower() in chrome
                                   or _is_page_number(text)):
                stripped.append(text)
            else:
                out.append(ln)
        pg.lines = out
        kept.append(pg)
    warnings = []
    for key in sorted(chrome):
        warnings.append(f"stripped repeating page header/footer: {key[:60]!r}")
    return warnings, stripped


# ------------------------------------------------------------ reading order

def _column_runs(lines: List[_Line]) -> List[List[_Line]]:
    """Reading-order runs: one per column when the page is columnar else one."""
    body = [ln for ln in lines if not ln.blank and ln.width > 0]
    if len(body) < 4:
        return [lines]
    groups: List[List[_Line]] = []
    for ln in sorted(body, key=lambda l: l.x0):
        if groups and ln.x0 < max(l.x1 for l in groups[-1]):
            groups[-1].append(ln)
        else:
            groups.append([ln])
    merged: List[List[_Line]] = []
    for g in groups:                       # merge x-overlapping groups
        left, right = min(l.x0 for l in g), max(l.x1 for l in g)
        if merged:
            p_left, p_right = min(l.x0 for l in merged[-1]), max(l.x1 for l in merged[-1])
            if min(p_right, right) - max(p_left, left) > 0.5 * min(p_right - p_left,
                                                                   right - left):
                merged[-1] = merged[-1] + g
                continue
        merged.append(g)
    if len(merged) < 2 or any(len(g) < 2 for g in merged):
        return [lines]
    merged.sort(key=lambda g: min(l.x0 for l in g))
    return [sorted(g, key=lambda l: (l.y0, l.x0)) for g in merged]


def group_paragraphs(lines: Sequence[_Line]) -> List[List[_Line]]:
    """Group a page's ordered lines into paragraphs (gap analysis)."""
    lines = list(lines)
    med = _median([ln.size for ln in lines if ln.text.strip()])
    widest = max([ln.width for ln in lines] or [0.0])
    for ln in lines:
        ln.heading = bool(med and ln.size and ln.size >= HEADING_SIZE_FACTOR * med
                          and len(ln.stripped) <= 90)
    paras: List[List[_Line]] = []
    cur: List[_Line] = []
    prev: Optional[_Line] = None
    for ln in lines:
        if ln.blank:
            if cur:
                paras.append(cur)
                cur, prev = [], None
            continue
        if prev is None or _para_break(prev, ln, widest):
            if cur:
                paras.append(cur)
            cur = [ln]
        else:
            cur.append(ln)
        prev = ln
    if cur:
        paras.append(cur)
    return [p for p in paras if any(ln.stripped for ln in p)]


def _para_break(prev: _Line, cur: _Line, widest: float) -> bool:
    if prev.heading or cur.heading:
        return True
    if cur.y0 - prev.y1 > GAP_FACTOR * ((prev.height + cur.height) / 2):
        return True
    em = max(prev.size, cur.size, 1.0)
    if cur.x0 - prev.x0 > INDENT_FACTOR * em and cur.y0 > prev.y1:
        return True
    if (prev.ends_sentence and prev.width < SHORT_LINE_RATIO * widest
            and cur.starts_upper):
        return True
    return False


# -------------------------------------------------------------- paragraphs

def _join_lines(lines: Sequence[_Line]) -> str:
    """Join lines into paragraph text, rejoining hyphenated line breaks."""
    out = ""
    for ln in lines:
        text = ln.stripped
        if not text:
            continue
        if not out:
            out = text
        elif out.endswith("-") and not out.endswith("--") and text[:1].islower():
            out = out[:-1] + text          # "them-" + "selves" -> "themselves"
        else:
            out = f"{out} {text}"
    return re.sub(r"\s+", " ", out).strip()


def _paragraphs(pages: List[_Page]) -> List[_Para]:
    paras: List[_Para] = []
    for pg in pages:
        for run in _column_runs(pg.lines):
            for group in group_paragraphs(run):
                text = _join_lines(group)
                if text:
                    paras.append(_Para(page=pg.number, lines=group, text=text))
    _rejoin_page_hyphen(paras)
    return paras


def _rejoin_page_hyphen(paras: List[_Para]) -> None:
    """Rejoin a word hyphenated across a page break."""
    for i in range(len(paras) - 1):
        a, b = paras[i], paras[i + 1]
        if (b.page != a.page + 1 or not a.text.endswith("-")
                or a.text.endswith("--") or not b.text[:1].islower()):
            continue
        paras[i] = _Para(a.page, a.lines, a.text[:-1] + b.text)
        paras[i + 1] = _Para(b.page, b.lines, "")
    for i in range(len(paras) - 1, 0, -1):
        if paras[i].text == "":
            del paras[i]


# ----------------------------------------------------------------- sections

def _toc_entries(doc) -> List[Tuple[str, int]]:
    """First-level TOC entries (title, page) — the section titles."""
    try:
        toc = [t for t in doc.get_toc() if len(t) == 3 and (t[2] or 0) > 0]
    except Exception:
        return []
    if not toc:
        return []
    top = min(t[0] for t in toc)
    out: List[Tuple[str, int]] = []
    seen = set()
    for t in toc:
        if t[0] != top:
            continue
        title, page = str(t[1]).strip(), int(t[2])
        if title and (title, page) not in seen:
            seen.add((title, page))
            out.append((title, page))
    return out


def _make_section(idx: int, title: Optional[str], items: Sequence[_Para]) -> Section:
    sec = Section(idx=idx, title=title)
    for it in items:
        if it.is_formula:
            from .model import Sentence
            sec.paragraphs.append(Paragraph(
                idx=len(sec.paragraphs), page=it.page, no_tts=True,
                sentences=[Sentence(0, FORMULA_MARKER, [FORMULA_MARKER])]))
        else:
            sec.paragraphs.append(
                paragraph_from_text(it.text, it.page, idx=len(sec.paragraphs)))
    return sec


def _sections_from_toc(paras: Sequence[_Para], doc) -> Tuple[List[Section], bool]:
    """Sections from TOC pages. Returns (sections, mapping_looked_broken)."""
    entries = sorted(_toc_entries(doc), key=lambda e: e[1])
    sections: List[Section] = []
    cur_title: Optional[str] = None
    cur: List[_Para] = []
    i = 0
    for p in paras:
        while i < len(entries) and p.page >= entries[i][1]:
            sections.append(_make_section(len(sections), cur_title, cur))
            cur, cur_title = [], entries[i][0]
            i += 1
        cur.append(p)
    sections.append(_make_section(len(sections), cur_title, cur))
    filled = [s for s in sections if s.paragraphs]
    broken = bool(sections) and len(filled) / len(sections) < 0.5
    return filled, broken


def _is_heading_para(para: _Para, med: float) -> bool:
    """A lone line set distinctly larger than the body text is a section title."""
    if not med or len(para.lines) != 1:
        return False
    line = para.lines[0]
    return bool(line.size >= HEADING_SIZE_FACTOR * med
                and len(para.text) <= 90
                and not para.text.endswith(".")
                and _WORDS.search(para.text))


def _sections_by_headings(paras: Sequence[_Para]) -> List[Section]:
    """Fallback sectioning: single short lines in a larger font are titles."""
    med = _median([ln.size for p in paras for ln in p.lines if ln.stripped])
    sections: List[Tuple[Optional[str], List[_Para]]] = [(None, [])]
    for p in paras:
        if _is_heading_para(p, med):
            sections.append((p.text, []))
        else:
            sections[-1][1].append(p)
    filled = [(title, items) for title, items in sections if items]
    return [_make_section(i, title, items) for i, (title, items) in enumerate(filled)]


def _build_sections(paras: Sequence[_Para], doc) -> Tuple[List[Section], List[str]]:
    warnings: List[str] = []
    if _toc_entries(doc):
        sections, broken = _sections_from_toc(paras, doc)
        if not broken:
            for i, s in enumerate(sections):
                s.idx = i
            return sections, warnings
        warnings.append("table of contents pages did not line up with text pages; "
                        "text kept in reading order")
    sections = _sections_by_headings(paras)
    if not any(s.title for s in sections):
        warnings.append("no table of contents or detectable headings; "
                        "single untitled section")
    return sections, warnings


# ------------------------------------------------------------------ public

def extract(path: str) -> Extraction:
    """Extract a PDF into an `Extraction` (sections, warnings, metadata)."""
    try:
        doc = pymupdf.open(path)
    except Exception as exc:                       # unreadable / not a pdf
        _fail(f"cannot open pdf: {exc}")
        raise
    with doc:
        pages = _collect_pages(doc)
        warnings = _check_extractable(pages)
        chrome_warnings, stripped = _strip_chrome(pages)
        warnings.extend(chrome_warnings)
        paras = _paragraphs(pages)
        if not any(p.text.strip() for p in paras):
            _fail(f"empty text extraction \u2014 no readable text in "
                  f"{os.path.basename(path)}")
        sections, section_warnings = _build_sections(paras, doc)
        meta = doc.metadata or {}
        title = (meta.get("title") or "").strip()
        author = (meta.get("author") or "").strip() or None
        return Extraction(title=title, author=author, sections=sections,
                          warnings=warnings + section_warnings)

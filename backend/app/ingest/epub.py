"""EPUB extraction: zipfile + xml.etree + BeautifulSoup (no ebooklib).

Flow: META-INF/container.xml -> OPF (metadata, spine) -> per-document XHTML ->
paragraph blocks. Headings (h1-h6) become section titles and an h-tag ``id``
becomes the anchor of that section's first paragraph; ``<img>`` is dropped.
EPUBs have no fixed pages, so paragraph ``page`` provenance is the 1-based
spine ordinal of the content document it came from.
"""
from __future__ import annotations

import os
import posixpath
import re
import zipfile
from typing import List, Optional, Tuple
from xml.etree import ElementTree as ET

from bs4 import BeautifulSoup

from .chunker import normalize_text
from .model import Extraction, Section, paragraph_from_text

MIN_TEXT_CHARS = 200                 # average chars per content document
_HEADING_TAGS = ("h1", "h2", "h3", "h4", "h5", "h6")
_PARA_TAGS = ("p", "li", "blockquote", "pre", "dd", "dt")
_SKIP_TAGS = ("img", "svg", "script", "style", "head", "meta", "link",
              "audio", "video", "source", "use", "br")
_HAS_LETTER = re.compile(r"[^\W_]", re.U)

#: a block as the sectioning step consumes it
_Block = Tuple[str, Optional[str], str, int]       # kind, anchor, text, ordinal


def _local(tag) -> str:
    return str(tag).split("}", 1)[-1].lower()


def _container_opf(zf: zipfile.ZipFile) -> str:
    """OPF path declared by META-INF/container.xml."""
    try:
        with zf.open("META-INF/container.xml") as fh:
            root = ET.fromstring(fh.read())
    except KeyError as exc:
        raise LookupError("META-INF/container.xml missing") from exc
    for node in root.iter():
        if _local(node.tag) in ("rootfile", "resource"):
            href = node.get("full-path")
            if href:
                return href
    raise LookupError("container.xml declares no OPF resource")


def _parse_opf(zf: zipfile.ZipFile, opf_path: str) -> Tuple[dict, List[str]]:
    """OPF -> (metadata, spine hrefs in reading order)."""
    with zf.open(opf_path) as fh:
        root = ET.fromstring(fh.read())
    base = posixpath.dirname(opf_path)
    meta = {"title": None, "author": None}
    hrefs: dict = {}
    spine: List[str] = []
    for node in root.iter():
        tag, attrs = _local(node.tag), node.attrib
        if tag in ("title", "creator"):
            key = "author" if tag == "creator" else "title"
            text = (node.text or "").strip()
            if text and not meta.get(key):
                meta[key] = text
        elif tag == "item":
            href, id_ = attrs.get("href"), attrs.get("id")
            if href and id_:
                hrefs[id_] = unquote_href(href)
        elif tag == "itemref":
            idref = attrs.get("idref")
            if idref and idref in hrefs:
                spine.append(hrefs[idref])
    if base and base not in (".", ""):
        spine = [posixpath.normpath(posixpath.join(base, h)) for h in spine]
    return meta, spine


def unquote_href(href: str) -> str:
    """Percent-decodes are legal in OPF hrefs."""
    from urllib.parse import unquote
    return unquote(href)


def _text_of(node) -> str:
    return normalize_text(node.get_text(" ")).strip()


def _walk(body, ordinal: int, blocks: List[_Block]) -> None:
    """Collect blocks in document order; headings become section titles."""
    from bs4.element import Tag
    for child in body.children:
        if not isinstance(child, Tag):
            continue
        tag = (child.name or "").lower()
        if tag in _SKIP_TAGS:
            continue
        if tag in _HEADING_TAGS:
            text = _text_of(child)
            if text:
                blocks.append(("title", child.get("id"), text, ordinal))
            continue
        if tag in _PARA_TAGS:
            text = _text_of(child)
            if text and _HAS_LETTER.search(text):
                blocks.append(("para", child.get("id"), text, ordinal))
            continue
        if tag in ("div", "section", "article", "main", "body", "figure",
                   "ul", "ol", "dl", "table", "tbody", "tr", "td", "th"):
            _walk(child, ordinal, blocks)
            continue
        text = _text_of(child)
        if text and _HAS_LETTER.search(text):
            blocks.append(("para", child.get("id"), text, ordinal))


def _doc_blocks(html: bytes, ordinal: int) -> List[_Block]:
    soup = BeautifulSoup(html, "html.parser")
    for bad in soup.find_all(list(_SKIP_TAGS) + ["img"]):
        bad.decompose()
    body = soup.body or soup.html or soup
    blocks: List[_Block] = []
    _walk(body, ordinal, blocks)
    return blocks


def _sections(blocks: List[_Block]) -> List[Section]:
    """Headings split sections; the heading anchor lands on its first paragraph."""
    pending: List[Tuple[Optional[str], Optional[str], List[_Block]]] = [
        (None, None, [])]
    for kind, anchor, text, ordinal in blocks:
        if kind == "title":
            pending.append((text, anchor, []))
        else:
            pending[-1][2].append((anchor, text, ordinal))
    out: List[Section] = []
    for title, anchor, items in pending:
        if not items and not title:
            continue
        sec = Section(idx=len(out), title=title)
        next_anchor = anchor
        for aid, text, ordinal in items:
            sec.paragraphs.append(paragraph_from_text(
                text, page=ordinal, anchor=aid or next_anchor,
                idx=len(sec.paragraphs)))
            next_anchor = None
        out.append(sec)
    return out or [Section(idx=0, title=None)]


def extract(path: str) -> Extraction:
    """Extract an EPUB into an `Extraction` (sections, warnings, metadata)."""
    from .service import IngestError

    def refuse(message: str, warnings: List[str]):
        exc = IngestError(message)
        exc.warnings = list(warnings)          # type: ignore[attr-defined]
        raise exc

    try:
        zf = zipfile.ZipFile(path)
    except Exception as exc:
        refuse(f"cannot open epub: {exc}", [])
        return                              # unreachable
    with zf:
        try:
            opf = _container_opf(zf)
            meta, spine = _parse_opf(zf, opf)
        except Exception as exc:
            refuse(f"cannot read epub package: {exc}", [])
            return

        blocks: List[_Block] = []
        skipped: List[int] = []
        for ordinal, href in enumerate(spine, start=1):
            try:
                html = zf.read(href)
            except KeyError:
                skipped.append(ordinal)
                continue
            doc_blocks = _doc_blocks(html, ordinal)
            if not any(k == "para" for k, _a, _t, _o in doc_blocks):
                skipped.append(ordinal)
            blocks.extend(doc_blocks)

        chars = sum(len(re.sub(r"\s+", "", t)) for k, _a, t, _o in blocks
                    if k == "para")
        warnings: List[str] = []
        per_doc = chars / max(1, len(spine))
        if not blocks or per_doc < MIN_TEXT_CHARS:
            refuse(f"image-heavy document \u2014 no extractable text "
                   f"(skipped pages {_as_ranges(skipped) or '1'})",
                   [f"image-heavy: average {int(per_doc)} chars per epub document"])
            return
        if skipped:
            warnings.append(f"image-only pages skipped: {_as_ranges(skipped)}")
        sections = _sections(blocks)
        if not any(s.paragraphs for s in sections):
            refuse(f"empty text extraction \u2014 no readable text in "
                   f"{os.path.basename(path)}", [])
        return Extraction(title=meta.get("title")
                          or os.path.splitext(os.path.basename(path))[0],
                          author=meta.get("author"),
                          sections=sections, warnings=warnings)


def _as_ranges(nums: List[int]) -> str:
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

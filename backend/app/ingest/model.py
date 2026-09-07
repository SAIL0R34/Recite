"""Typed intermediate representation of an ingested book.

`Document.to_dict()` is the single place the document.json schema lives; the
extractors build a Document, the chunker reads it, service.py writes it.

Schema (exactly what lands in books/<id>/document.json)::

    {"id","title","author","format","source_path","content_hash",
     "warnings":[...],
     "sections":[{"idx":0,"title":"Chapter 1",
                  "paragraphs":[{"idx":3,"page":12,"anchor":null,"no_tts":true,
                                 "sentences":[{"idx":0,"text":"\u2026","words":["\u2026"]}]}]}]}

`anchor` is only ever non-null for EPUB paragraphs (element ids). `no_tts`
marks formula/code paragraphs: they stay in the document for page
provenance but are never sent to TTS (chunker skips them).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional

from .chunker import clean_whitespace, normalize_text, words_of

# ---------------------------------------------------------------- sentences

#: abbreviations / initials that end in "." but do not end a sentence
_ABBREWS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "sen", "gen", "col",
    "capt", "lieut", "maj", "sgt", "adj", "adm", "rev", "hon", "fr", "inq",
    "vs", "etc", "eg", "ie", "vol", "nos", "fig", "cf", "inc", "ltd", "dept",
    "est", "approx", "pref", "ed", "eds", "trans", "ch", "pp", "sec", "para",
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    "govt", "eng", "phil", "technol", "comput", "univ", "inst", "math",
}
#: words that are never sentence-final even though they look like endings
_NOT_FINAL = {".", "-", "--", "\u2013", "\u00b7", "\u2022", "\u00b0"}
_TRAILER = re.compile(r"""^[\u0022\u2019\u201d''\]\)】\u00b7]*$""")
_TERMINATORS = ".!?"
_OPENERS = {"", "\u201c", "\u2018", "'", '"', "(", "[", "-"}
_INITIALS = re.compile(r"(?:[A-Za-z]\.)+")
_HAS_LETTER = re.compile(r"[^\W_]")


def _is_abbrev(word: str) -> bool:
    """`word` is the last word of a candidate sentence, including its '.'."""
    if not word:
        return False
    core = word.rstrip(".\"'\u2019\u201d)]")
    if core in _NOT_FINAL:
        return True
    low = core.lower().strip(".")
    if low in _ABBREWS:
        return True
    if _INITIALS.fullmatch(word.rstrip('"\')') if word.endswith(".") else word):
        return True
    # single capital + period ("B." mid-sentence)
    if len(core) == 1 and core.isalpha() and core.isupper():
        return True
    return False


def _sentence_end(word: str) -> bool:
    """Does this word terminate a sentence (period/?/! possibly + quote)?"""
    if not word or word in _NOT_FINAL:
        return False
    body = word.rstrip('"\'\u201d\u2019)]')
    if not body or body[-1] not in _TERMINATORS:
        return False
    if not _HAS_LETTER.search(body):        # "." , "5." , "-"
        return False
    return not _is_abbrev(word)


def _starts_sentence(word: str) -> bool:
    for ch in word[:1]:
        if ch in _OPENERS:
            return True
        return ch.isupper()
    return False


def split_sentences(text: str) -> List[str]:
    """Split one paragraph's text into sentences (abbrev-aware).

    A break happens after a word that terminates a sentence (``.!?`` possibly
    followed by a quote/bracket) when the next word can start a sentence.
    """
    text = clean_whitespace(normalize_text(text))
    if not text:
        return []
    words = text.split(" ")
    out: List[str] = []
    cur: List[str] = []
    for i, word in enumerate(words):
        cur.append(word)
        if i + 1 >= len(words):
            continue
        if _sentence_end(word) and _starts_sentence(words[i + 1]):
            out.append(" ".join(cur))
            cur = []
    if cur:
        out.append(" ".join(cur))
    return [s.strip() for s in out if s.strip()]


# ---------------------------------------------------------------- paragraphs


@dataclass
class Sentence:
    idx: int
    text: str
    words: List[str]

    def to_dict(self) -> dict:
        return {"idx": self.idx, "text": self.text, "words": self.words}


@dataclass
class Paragraph:
    idx: int
    page: Optional[int]
    anchor: Optional[str] = None
    no_tts: bool = False
    sentences: List[Sentence] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(s.text for s in self.sentences)

    def to_dict(self) -> dict:
        d = {"idx": self.idx, "page": self.page, "anchor": self.anchor,
             "sentences": [s.to_dict() for s in self.sentences]}
        if self.no_tts:
            d["no_tts"] = True
        return d


@dataclass
class Section:
    idx: int
    title: Optional[str] = None
    paragraphs: List[Paragraph] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"idx": self.idx, "title": self.title,
                "paragraphs": [p.to_dict() for p in self.paragraphs]}


@dataclass
class Document:
    id: str
    title: str
    author: Optional[str]
    format: str
    source_path: str
    content_hash: str
    warnings: List[str] = field(default_factory=list)
    sections: List[Section] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"id": self.id, "title": self.title, "author": self.author,
                "format": self.format, "source_path": self.source_path,
                "content_hash": self.content_hash,
                "warnings": list(self.warnings),
                "sections": [s.to_dict() for s in self.sections]}

    @property
    def total_words(self) -> int:
        return sum(len(s.words) for sec in self.sections
                   for p in sec.paragraphs for s in p.sentences)

    @property
    def all_paragraphs(self) -> List[Paragraph]:
        return [p for sec in self.sections for p in sec.paragraphs]

    def to_manifest_sections(self) -> List[dict]:
        """Shape expected by chunker.plan_sections."""
        return [{"idx": s.idx, "title": s.title,
                 "paragraphs": [{"idx": p.idx, "no_tts": p.no_tts,
                                 "sentences": [{"text": s.text} for s in p.sentences]}
                                for p in s.paragraphs]}
                for s in self.sections]


@dataclass
class Extraction:
    """What an extractor returns, before ids and hashes exist."""
    title: str
    author: Optional[str] = None
    sections: List[Section] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


def make_sentences(text: str) -> List[Sentence]:
    """Normalized text -> indexed Sentence list (used by both extractors)."""
    return [Sentence(i, s, words_of(s)) for i, s in enumerate(split_sentences(text))]


def paragraph_from_text(text: str, page: Optional[int],
                        anchor: Optional[str] = None,
                        no_tts: bool = False, idx: int = 0) -> Paragraph:
    return Paragraph(idx=idx, page=page, anchor=anchor, no_tts=no_tts,
                     sentences=make_sentences(text))

"""Text normalization and deterministic sentence -> chunk grouping.

Determinism matters: identical input text must produce a byte-identical
manifest, because the TTS worker caches audio per chunk index.

Rules (approved plan):
  * group sentences *within* a paragraph up to ~MAX_CHUNK_CHARS
  * a paragraph break is always a chunk boundary (chunks never span paragraphs)
  * a single sentence over MAX_SENTENCE_CHARS is split at clause punctuation
    (comma / semicolon / colon / dash) into pseudo-sentences, each of which
    becomes a chunk of its own
  * paragraphs flagged ``no_tts`` (formula/code) are skipped entirely
"""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable, List, Tuple

MAX_CHUNK_CHARS = 300
MAX_SENTENCE_CHARS = 500
FORMULA_MARKER = "[formula]"

# ---------------------------------------------------------------- normalize

_LIGATURES = {
    "\uFB00": "ff", "\uFB01": "fi", "\uFB02": "fl", "\uFB03": "ffi",
    "\uFB04": "ffl", "\uFB05": "ft", "\uFB06": "st", "\u0132": "IJ",
    "\u00C6": "AE", "\u00E6": "ae", "\u0153": "oe", "\u0152": "OE",
    "\u00DE": "TH", "\u00FE": "th",
}
#: printable Basic Latin + Latin-1 Supplement + the unicode ranges a book
#: legitimately needs (punctuation, quotes, arrows, math, box drawing).
#: Everything else (emoji, CJK, emoji modifiers, private use) is dropped.
_KEEP = re.compile(
    "["
    "\x21-\x7e"                    # printable basic latin
    "\x20-\x7e"                   # (space + punctuation, deduped by charset)
    "\u00a2-\u00ff"               # latin-1 supplement
    "\u2010-\u2027\u2030-\u205f"  # punctuation incl. dashes/quotes/daggers
    "\u20a0-\u20bf"               # currency
    "\u2100-\u214f\u2190-\u22ff"  # letterlike, arrows, math operators
    "\u2500-\u259f"               # box drawing (tables)
    "]"
)
_KEEP_CHARS = set(chr(c) for c in range(0x21, 0x7F))
for _lo, _hi in ((0xA2, 0xFF), (0x2010, 0x2027), (0x2030, 0x205F),
                 (0x20A0, 0x20BF), (0x2100, 0x214F), (0x2190, 0x22FF),
                 (0x2500, 0x259F)):
    _KEEP_CHARS.update(chr(c) for c in range(_lo, _hi + 1))
_KEEP_CHARS.discard("\x7f")
# space and newline survive the char whitelist (structural, not glyphs)
_KEEP_CHARS.update("\n ")


_WS = re.compile(r"\s+")
_WS_BEFORE = re.compile(r"[ \t\u00a0\u2000-\u200b]+")


def normalize_text(text: str) -> str:
    """NFC normalize, replace ligatures, drop glyphs outside latin+latin-1."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", str(text))
    for bad, good in _LIGATURES.items():
        if bad in text:
            text = text.replace(bad, good)
    text = (text.replace("\u00ad", "")            # soft hyphen
                .replace("\r", "")
                .replace("\u2028", "\n").replace("\u2029", "\n")
                .replace("\x0b", "\n")
                .replace("\t", " ")
                .replace("\u00a0", " "))
    return "".join(ch for ch in text if ch in _KEEP_CHARS)


def clean_whitespace(text: str) -> str:
    """Collapse runs of spaces (keeping newlines) and strip the ends."""
    return _WS_BEFORE.sub(" ", text).strip()


def words_of(sentence_text: str) -> List[str]:
    """Whitespace word split; punctuation stays attached to words."""
    return clean_whitespace(sentence_text).split(" ")


# ---------------------------------------------------------- formula detection

FORMULA_SYMBOLS = (
    "\u2282\u2283\u2208\u2209\u222b\u2192\u2190\u2192\u2193\u2191\u2264\u2265"
    "\u2211\u220f\u221a\u221e\u221d\u2200\u2203\u2204\u2227\u2228\u2261\u2248"
    "\u2245\u2260\u2286\u2287\u2288\u228a\u228b\u22c0\u22c1\u22c2\u22c3\u21d2"
    "\u21d4\u2234\u2235\u2236\u2207\u2202\u00d7\u00f7\u00b1\u2212\u00a0"
)
_SYMBOLS = set(FORMULA_SYMBOLS) - {"\u00a0"}

_CODE_HINTS = re.compile(r"\{|\}|;|->|=>|::|&&|\{\{")


def symbol_density(text: str) -> float:
    """Fraction of non-space characters that are mathematical symbols."""
    body = re.sub(r"\s+", "", text)
    if not body:
        return 0.0
    return sum(1 for ch in body if ch in _SYMBOLS) / len(body)


def is_formula_text(text: str, threshold: float = 0.25) -> bool:
    """True when >threshold of the characters are math symbols."""
    return symbol_density(text) > threshold


def looks_like_code(text: str) -> bool:
    """Programmatic companion to the extractor's monospace-span check."""
    return len(_CODE_HINTS.findall(text)) >= 2


# ---------------------------------------------------------------- sentence splits

_CLAUSE_SPLIT = re.compile(r"(?<=[,;:])\s+|(?<=[\u2014\u2013])\s+")


def _word_bounded_split(sentence: str) -> List[str]:
    """Fallback when an over-long sentence has no clause punctuation."""
    out: List[str] = []
    cur: List[str] = []
    for word in sentence.split(" "):
        cur.append(word)
        if len(" ".join(cur)) >= MAX_CHUNK_CHARS:
            out.append(" ".join(cur))
            cur = []
    if cur:
        out.append(" ".join(cur))
    return out or [sentence]


def split_long_sentence(sentence: str) -> List[str]:
    """An over-long sentence becomes pseudo-sentences, else ``[sentence]``."""
    if len(sentence) <= MAX_SENTENCE_CHARS:
        return [sentence]
    parts = [p.strip() for p in _CLAUSE_SPLIT.split(sentence) if p and p.strip()]
    if len(parts) < 2:
        parts = _word_bounded_split(sentence)
    return parts or [sentence]


def chunk_paragraph(sentences: Iterable[str]) -> List[Tuple[int, int, str]]:
    """Group one paragraph's sentence texts into chunks.

    Returns ``[(first_sentence_idx, last_sentence_idx, text), \u2026]``;
    indices are positions inside *sentences*, so a chunk built from
    pseudo-sentences keeps that sentence's index for both ends.
    """
    sentences = list(sentences)
    out: List[Tuple[int, int, str]] = []
    buf: List[str] = []
    start = 0

    def flush(end_index: int) -> None:
        if buf:
            out.append((start, end_index, " ".join(buf)))
            buf.clear()

    for i, sentence in enumerate(sentences):
        pieces = split_long_sentence(sentence)
        if len(pieces) > 1:                      # oversized sentence: one chunk each
            flush(i - 1)
            for piece in pieces:
                out.append((i, i, piece))
            start = i + 1
            continue
        piece = pieces[0]
        if not buf:
            start, buf = i, [piece]
            continue
        joined = " ".join(buf + [piece])
        if len(joined) > MAX_CHUNK_CHARS:
            flush(i - 1)
            start, buf = i, [piece]
        else:
            buf.append(piece)
    flush(len(sentences) - 1)
    return out


def plan_sections(sections: List[dict]) -> Tuple[List[dict], int]:
    """document sections -> (init_manifest sections, total_words).

    `sections`: ``[{idx, title, paragraphs:[{idx, no_tts,
    sentences:[{text}]}]}]`` — typically ``Document.to_manifest_sections()``.
    """
    out: List[dict] = []
    total_words = 0
    for sec in sections:
        chunks: List[dict] = []
        for para in sec.get("paragraphs", []):
            if para.get("no_tts"):
                continue
            texts = [s.get("text", "") for s in para.get("sentences", [])]
            total_words += sum(len(words_of(t)) for t in texts)
            for s0, s1, text in chunk_paragraph(texts):
                chunks.append({"idx": len(chunks), "para": para["idx"],
                               "sentence_range": [s0, s1], "text": text})
        out.append({"idx": sec["idx"], "title": sec.get("title"), "chunks": chunks})
    return out, total_words

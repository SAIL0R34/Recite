"""Text layer: sentence splitting, normalization, chunk planning."""
from app.ingest.chunker import (FORMULA_MARKER, MAX_CHUNK_CHARS,
                                chunk_paragraph, is_formula_text,
                                looks_like_code, normalize_text,
                                plan_sections, split_long_sentence,
                                symbol_density, words_of)
from app.ingest.model import split_sentences


def test_split_sentences_basic():
    text = "One sentence here. Another one follows! Does it? Yes, it does."
    assert split_sentences(text) == ["One sentence here.",
                                     "Another one follows!",
                                     "Does it?",
                                     "Yes, it does."]


def test_split_sentences_abbreviations():
    text = "Dr. Adams met Mr. Bob at 3 a.m. in Vienna. He left at once."
    parts = split_sentences(text)
    assert len(parts) == 2
    assert parts[0].startswith("Dr. Adams")
    assert "at 3 a.m. in Vienna." in parts[0]


def test_split_sentences_no_split_before_lowercase():
    text = "She said. he refused to go. The end."
    parts = split_sentences(text)
    assert len(parts) == 2
    assert parts[0].startswith("She said. he")


def test_normalize_text_ligatures_and_forms():
    assert normalize_text("\ufb01sh") == "fish"          # ﬁ fish
    assert normalize_text("e\u0301") == "\u00e9"     # e + combining acute -> e-acute
    assert "\u4e28" not in normalize_text("kan\u4e28ji")   # CJK dropped
    assert "\t" not in normalize_text("a\tb")
    assert normalize_text("") == ""


def test_words_of_counts_words_not_spaces():
    assert words_of("one two  three") == ["one", "two", "three"]
    assert len(words_of("a")) == 1


def test_sentence_end_needs_capital_after():
    # lowercase continuation must not split even after a period
    assert len(split_sentences("Item 1. the value stayed put.")) == 1


def test_chunk_paragraph_bounds_and_coverage():
    sentence = ("The quick brown fox keeps running across the meadow while a "
                "reader follows along and the words scroll by")
    sents = [f"{word} {sentence}." for word in
             ("Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot",
              "Golf", "Hotel")]
    chunks = chunk_paragraph(sents)
    assert len(chunks) > 1
    for first, last, text in chunks:
        assert len(text) <= MAX_CHUNK_CHARS
    # contiguous coverage of the sentence list
    assert chunks[0][0] == 0
    assert chunks[-1][1] == len(sents) - 1
    for (a0, a1, _), (b0, _b1, _t) in zip(chunks, chunks[1:]):
        assert b0 == a1 + 1
    joined = " ".join(text for _f, _l, text in chunks)
    assert joined == " ".join(sents)


def test_chunk_paragraph_short_is_one_chunk():
    chunks = chunk_paragraph(["Short sentence one.", "And sentence two."])
    assert len(chunks) == 1
    assert chunks[0] == (0, 1, "Short sentence one. And sentence two.")


def test_split_long_sentence_at_clause_marks():
    clause = ("Every clause is long enough to matter, and it carries another "
              "clause; yet another one trails on, until the whole sentence is "
              "far past five hundred characters of plain ordinary narrative, ")
    long_sentence = clause * 8
    assert len(long_sentence) > 500
    parts = split_long_sentence(long_sentence)
    assert len(parts) > 1
    assert "".join(p.replace(" ", "").strip() for p in parts) == \
        long_sentence.replace(" ", "").strip()


def test_formula_detection():
    assert is_formula_text("∑θᵢ = α · β ⇒ ∫f(x)dx ≤ ∞") is True
    assert is_formula_text("The chapter describes the war in plain prose.") is False
    assert symbol_density("∀x ∃y (x ≤ y) ⇒ x + y") > 0.2
    assert looks_like_code("if (a && b) { return f(x); }") is True
    assert looks_like_code("A perfectly ordinary English sentence.") is False


def test_formula_marker_constant():
    assert FORMULA_MARKER == "[formula]"


def _sections_with_a_formula():
    return [
        {"idx": 0, "title": "T", "paragraphs": [
            {"idx": 0, "no_tts": False,
             "sentences": [{"text": "Spoken paragraph with two sentences."},
                           {"text": "The second one here."}]},
            {"idx": 1, "no_tts": True,
             "sentences": [{"text": FORMULA_MARKER}]},
            {"idx": 2, "no_tts": False,
             "sentences": [{"text": "Third paragraph."}]},
        ]},
    ]


def test_plan_sections_skips_no_tts_and_numbers_chunks():
    sections, total_words = plan_sections(_sections_with_a_formula())
    sec = sections[0]
    assert [c["para"] for c in sec["chunks"]] == [0, 2]
    assert [c["idx"] for c in sec["chunks"]] == [0, 1]
    assert sec["chunks"][0]["sentence_range"] == [0, 1]
    assert total_words == 11     # words of the two speakable paragraphs only


def test_plan_sections_is_deterministic():
    a = plan_sections(_sections_with_a_formula())
    b = plan_sections(_sections_with_a_formula())
    assert a == b



class _P:
    """mini paragraph: sentences are word lists."""
    def __init__(self, n_words, idx=0):
        self.idx = idx
        self.sentences = [type("S", (), {"words": ["w"] * n_words})()]
        self.text = "x"


class _Sec:
    def __init__(self, idx, title, paragraphs):
        self.idx, self.title, self.paragraphs = idx, title, paragraphs
    def __getattr__(self, k):            # front attr default
        raise AttributeError(k)


def test_presplit_splits_giant_chapter():
    from app.ingest.service import _presplit
    secs = [_Sec(0, f"Chapter {i}", [_P(600) for _ in range(20)])
            for i in range(1, 4)]
    out, front = _presplit(secs, max_words=4000)
    assert len(out) > 6 and front == []
    assert all(sum(len(s.words) for p in s.paragraphs for s in p.sentences)
               <= 4800 for s in out)
    assert any("part 2" in (s.title or "") for s in out)


def test_presplit_front_matter_no_tts():
    from app.ingest.service import _presplit
    secs = [_Sec(0, "Preface", [_P(10)]), _Sec(1, "Contents", [_P(10)])] + \
           [_Sec(2 + i, f"Chapter {i+1}", [_P(10)]) for i in range(3)]
    out, front = _presplit(secs)
    assert front == [0, 1]
    assert all(getattr(s, "front", False) for s in out[:2])
    assert not any(getattr(s, "front", False) for s in out[2:])

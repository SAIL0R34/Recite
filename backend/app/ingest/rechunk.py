"""Re-chunk an existing manifest under new chunker rules, keeping audio.

Chunk audio for a section lives in one MP3 and a chunk's slice is fully
determined by the chunk's ``text``; a chunk of the new plan whose
``(para, sentence_range, text)`` all equal a *ready* chunk of the old plan
already has its audio and word timings — copy it over and stay ``ready``.
Sections with any stale or missing chunk go back to ``pending`` (their old
MP3 is archived as ``.mp3.old``); the queue regenerates exactly those.

Paragraph stitching (chunker rule: never break mid-sentence) runs over the
stored document too — PDF geometry split one sentence across a "paragraph"
boundary. Stitched paragraphs change sentence indices, so their chunks miss
the (para, sentence_range, text) match and are regenerated; untouched
paragraphs keep their (para, sentence_range, text) triples and their audio.

Public contract::

    from app.ingest.rechunk import rechunk_book
    report = rechunk_book(book_id)   # -> summary dict
"""
from __future__ import annotations

import json
from typing import Dict, List, Tuple

from .. import config, manifestio
from .chunker import plan_sections
from .model import Paragraph, Section, Sentence

#: one line per rule that changes chunk boundaries; kept in sync with
#: chunker.RULE_VERSION by recheck at startup
from .chunker import RULE_VERSION  # noqa: E402


def _stitch_paragraphs(paras: List[Paragraph]) -> List[Paragraph]:
    """Merge a paragraph ending mid-sentence into the next (lowercase-open).

    Index-preserving variant of model.stitch_open_paragraphs: the surviving
    paragraph keeps its own idx; removed paragraphs leave gaps, which keeps
    every *other* paragraph's (para idx) match with its stored audio.
    """
    from .chunker import ends_terminal

    merged: List[Paragraph] = []
    i = 0
    while i < len(paras):
        a = paras[i]
        if a.no_tts or not a.sentences:
            merged.append(a)
            i += 1
            continue
        last = a.sentences[-1].text.rstrip()
        while (i + 1 < len(paras)
               and not ends_terminal(last)
               and not paras[i + 1].no_tts
               and paras[i + 1].sentences
               and paras[i + 1].sentences[0].text[:1].islower()):
            b = paras[i + 1]
            a.sentences.extend(b.sentences)
            for si, s in enumerate(a.sentences):
                s.idx = si
            last = a.sentences[-1].text.rstrip()
            i += 1
        merged.append(a)
        i += 1
    return merged


def _doc_to_sections(doc: dict) -> Tuple[List[Section], set]:
    sections: List[Section] = []
    no_tts: set = set()
    for sec in doc.get("sections") or []:
        paras: List[Paragraph] = []
        for para in sec.get("paragraphs") or []:
            paras.append(Paragraph(
                idx=para.get("idx", len(paras)), page=para.get("page"),
                anchor=para.get("anchor"), no_tts=bool(para.get("no_tts")),
                sentences=[Sentence(idx=s.get("idx", i), text=s.get("text", ""),
                                    words=list(s.get("words") or []))
                           for i, s in enumerate(para.get("sentences") or [])]))
        stitched = _stitch_paragraphs(paras)
        if stitched and all(p.no_tts for p in stitched):
            no_tts.add(sec.get("idx"))
        sections.append(Section(idx=sec.get("idx"), title=sec.get("title"),
                                paragraphs=stitched))
    return sections, no_tts


def _dur(chunk: dict) -> int:
    return int(chunk.get("duration_ms") or 0)


def _ready(chunk: dict) -> bool:
    return chunk.get("status") == "ready" and bool(chunk.get("words"))


def _payload(sec: Section) -> dict:
    return {"idx": sec.idx, "title": sec.title,
            "paragraphs": [{"idx": p.idx, "no_tts": p.no_tts,
                            "sentences": [{"text": s.text}
                                          for s in p.sentences]}
                           for p in sec.paragraphs]}


def plan_new_sections(old_sections: List[dict], stitched: List[Section],
                      no_tts: set) -> Tuple[List[dict], dict]:
    """Deterministic: old manifest sections + stitched sections -> new + report."""
    by_idx = {s.idx: s for s in stitched}
    report = {"kept": 0, "stale": 0, "new": 0, "kept_ms": 0, "stale_ms": 0,
              "sections_kept": 0, "sections_reset": 0, "reset_idxs": []}
    out: List[dict] = []
    for sec_old in old_sections:
        idx = sec_old.get("idx")
        if idx in no_tts or sec_old.get("tts") is False:
            out.append({**sec_old, "status": "ready", "chunks": []})
            continue
        section = by_idx.get(idx)
        if section is None:
            continue                         # vanished from the document
        planned, _tw = plan_sections([_payload(section)])
        planned_chunks = (planned[0].get("chunks") if planned else []) or []
        old_by_key: Dict[Tuple, dict] = {}
        for c in sec_old.get("chunks") or []:
            key = (c.get("para"), tuple(c.get("sentence_range") or [0, 0]),
                   c.get("text"))
            old_by_key[key] = c
        new_chunks: List[dict] = []
        kept_ms = stale_ms = 0
        stale = False
        for pc in planned_chunks:
            oc = old_by_key.get((pc["para"], tuple(pc["sentence_range"]),
                                 pc["text"]))
            if oc is not None and _ready(oc):
                chunk = dict(oc)
                chunk["idx"] = pc["idx"]     # order may have shifted
                new_chunks.append(chunk)
                kept_ms += _dur(oc)
                report["kept"] += 1
            else:
                new_chunks.append(
                    {"idx": pc["idx"], "section": idx, "para": pc["para"],
                     "sentence_range": list(pc["sentence_range"]),
                     "text": pc["text"], "global_start_ms": None,
                     "duration_ms": None, "status": "pending", "words": None})
                stale = True
                if oc is not None:
                    report["stale"] += 1
                    stale_ms += _dur(oc)
                else:
                    report["new"] += 1
        # a section may not hold silent holes: any stale slice re-queues the
        # whole section (its old audio is archived below)
        if stale:
            new_chunks = [dict(c, status="pending", global_start_ms=None,
                               duration_ms=None, words=None)
                          for c in new_chunks]
            status, duration_ms = "pending", None
            report["sections_reset"] += 1
        else:
            status, duration_ms = "ready", sec_old.get("duration_ms")
            report["sections_kept"] += 1
        out.append({"idx": idx, "title": section.title,
                    "audio": f"audio/section-{idx:03d}.mp3",
                    "duration_ms": duration_ms, "status": status, "tts": True,
                    "chunks": new_chunks})
    return out, report


def rechunk_book(book_id: str) -> dict:
    """Re-plan every section from document.json (mid-sentence paragraph
    stitching included); keep audio for chunks whose text is unchanged.
    Returns a summary dict."""
    dp = config.book_file(book_id, "document.json")
    if not dp.exists():
        raise FileNotFoundError(f"no document.json for book {book_id}")
    doc = json.loads(dp.read_text(encoding="utf-8"))
    manifest = manifestio.load(book_id)
    if manifest is None:
        raise FileNotFoundError(f"no manifest.json for book {book_id}")
    sections, no_tts = _doc_to_sections(doc)

    # persist the stitched document so the reader renders stitched paragraphs
    doc["sections"] = [s.to_dict() for s in sections]
    tmp = dp.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    tmp.replace(dp)

    new_sections, report = plan_new_sections(manifest.get("sections") or [],
                                             sections, no_tts)
    manifest["sections"] = new_sections
    manifest["rule_version"] = RULE_VERSION
    manifestio.save(book_id, manifest)
    # archive the stale final audio of reset sections
    for sec in new_sections:
        if sec["status"] == "pending" and sec.get("tts", True):
            p = config.book_file(book_id, f"audio/section-{sec['idx']:03d}.mp3")
            try:
                if p.exists():
                    p.replace(p.with_suffix(".mp3.old"))
            except OSError:
                pass
    report["sections_total"] = len(new_sections)
    report["rule_version"] = RULE_VERSION
    return report


def needs_rechunk(manifest: dict) -> bool:
    from .chunker import RULE_VERSION as want
    return int(manifest.get("rule_version") or 0) < want


def recheck_all() -> List[dict]:
    """Startup sweep: re-chunk every book whose manifest predates the
    current chunker RULE_VERSION. Audio for unchanged chunk texts is kept."""
    out: List[dict] = []
    if not config.BOOKS_DIR_PATH.exists():
        return out
    for d in sorted(config.BOOKS_DIR_PATH.iterdir()):
        mp, dp = d / "manifest.json", d / "document.json"
        if not (mp.exists() and dp.exists()):
            continue
        try:
            m = json.loads(mp.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not needs_rechunk(m):
            continue
        try:
            r = rechunk_book(d.name)
            r["book_id"] = d.name
            out.append(r)
        except Exception:
            continue
    return out

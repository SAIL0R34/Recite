"""LLM chunk planner — opt-in, external, never trusted with text.

When an OpenAI-compatible chat endpoint is configured (config.LLM_*), an
external model chooses where narration chunks break: semantic, prosody-aware
boundaries instead of the punctuation heuristic. The model NEVER rewrites
text — it returns sentence-index groups per paragraph, and chunk text is
built here from the stored sentences. That is load-bearing: the audio-reuse
key matches on (para, sentence_range, text), and word timings must line up
with the sentences the reader renders.

Every hard invariant is enforced locally: groups must cover each paragraph's
sentences exactly, stay inside one paragraph, and respect the char budget
(oversize groups are re-cut by the existing heuristic). Any failure — no
config, timeout, HTTP error, malformed JSON, invalid groups — falls back to
the heuristic for that section; a Breaker stops asking after N consecutive
failures. Unset endpoints make no network calls at all.
"""
from __future__ import annotations

import json
import re
from typing import List, Optional, Tuple

import httpx

from .. import config
from .chunker import MAX_CHUNK_CHARS, chunk_paragraph, plan_sections, words_of

#: groups under this fold into a same-paragraph neighbour (a tiny fragment
#: is a local error; rejecting the section would discard good boundaries)
MIN_CHUNK_CHARS = 40

# How the model sees a section: rules, then one block per speakable
# paragraph with its sentences numbered and char-counted.
_SYSTEM = (
    "You are a narration chunk planner for a text-to-speech reader. "
    "You choose where spoken chunks of a book begin and end. "
    "You never rewrite, reorder, or omit text: you only return "
    "sentence-index ranges. Respond with a single JSON object and "
    "no other text."
)

_RULES = """Group the numbered sentences below into narration chunks.

Rules:
- For each paragraph, output one string: one character per sentence, in
  order, where "1" marks the first sentence of a chunk and "0" marks a
  sentence that continues the current chunk. The string's length equals
  that paragraph's sentence count, and its first character is always "1".
  Example: a 4-sentence paragraph breaking after the 2nd sentence is "1100".
- A chunk stays inside one paragraph.
- Aim for 120-300 characters per chunk; each sentence's character count is in parentheses.
- Break where a narrator would breathe: prefer boundaries after . ! ? over , ; :
- Keep short rhetorical pairs (call and response, question and answer) in one chunk.
- Lines are "i (n) text" where i is the sentence index within its paragraph.

Respond with exactly this JSON shape and nothing else:
{"breaks": {"<paragraph id>": "100101..."}}
"""


class _LlmError(Exception):
    """One planner attempt failed; `.reason` lands in the report."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def llm_configured() -> bool:
    return bool(config.LLM_BASE_URL and config.LLM_MODEL)


def llm_status() -> dict:
    """Endpoint status for the API — the key never leaves the process."""
    return {"configured": llm_configured(), "model": config.LLM_MODEL,
            "base": config.LLM_BASE_URL}


class Breaker:
    """N consecutive failures -> stop asking for the rest of the operation."""

    def __init__(self, max_failures: int):
        self.max_failures = max(1, max_failures)
        self._streak = 0

    @property
    def open(self) -> bool:
        return self._streak >= self.max_failures

    def record(self, ok: bool) -> None:
        self._streak = 0 if ok else self._streak + 1


def _chat_url() -> str:
    # Users paste ".../v1" out of habit; the chat path is appended either way.
    base = config.LLM_BASE_URL.rstrip("/")
    if base.endswith("/v1"):
        return base + "/chat/completions"
    return base + "/v1/chat/completions"


def make_client() -> httpx.Client:
    headers = {}
    if config.LLM_API_KEY:
        headers["Authorization"] = f"Bearer {config.LLM_API_KEY}"
    return httpx.Client(timeout=config.LLM_TIMEOUT_S, headers=headers)


def render_user_message(section: dict) -> str:
    lines = [_RULES]
    for para in section.get("paragraphs", []):
        if para.get("no_tts") or not para.get("sentences"):
            continue
        lines.append(f"paragraph {para['idx']}:")
        for i, s in enumerate(para["sentences"]):
            t = (s.get("text") or "").replace("\n", " ")  # length-preserving
            lines.append(f"{i} ({len(t)}) {t}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _extract_content(payload: dict) -> str:
    try:
        message = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        raise _LlmError("bad_response")
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content
    # A reasoning model that spent its whole budget thinking returns an
    # empty content; its reasoning usually drafts the answer at the end,
    # and the fence-tolerant loader's outermost-brace scan can find it.
    reasoning = message.get("reasoning_content")
    if isinstance(reasoning, str) and reasoning.strip():
        return reasoning
    raise _LlmError("bad_response")


_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.DOTALL)


def _candidate_objects(text: str) -> List[str]:
    """Top-level balanced {…} spans in document order (string-aware, so
    braces inside JSON string values don't confuse the count)."""
    spans: List[str] = []
    depth, start = 0, -1
    in_str = esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    spans.append(text[start:i + 1])
    return spans


def _loads_content(content: str) -> Optional[dict]:
    """Content -> a JSON object. Tolerates markdown fences, inline
    <think> blocks, and salvaged reasoning drafts (which may contain
    false-start JSON before the real answer — so candidates are tried
    from the LAST backwards, where a drafted final answer lives)."""
    text = _THINK_BLOCK.sub("", content.strip()).strip()
    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass
    for cand in reversed(_candidate_objects(text)):
        try:
            payload = json.loads(cand)
            if isinstance(payload, dict):
                return payload
        except json.JSONDecodeError:
            continue
    return None


def _parse_groups(content: str) -> Optional[list]:
    """Legacy shape: {"groups": [{"para", "from", "to"}]} (still accepted)."""
    payload = _loads_content(content)
    groups = payload.get("groups") if payload else None
    return groups if isinstance(groups, list) else None


def groups_from_breaks(paragraphs: List[dict],
                       breaks: dict) -> Optional[List[dict]]:
    """Compact shape: {"breaks": {"<para>": "100101…"}} -> groups.

    One character per sentence, "1" = a chunk starts there. Output tokens
    are what local models are slow at — a bitmask costs ~1 token per
    sentence instead of ~30 per group, which is the difference between
    a section finishing in seconds and timing out. Unknown paragraph keys
    are ignored (harmless model echo); every speakable paragraph must have
    a binary mask. Small models are sloppy counters, so length is REPAIRED
    (truncate extras / extend the last chunk over a missing tail, and the
    first sentence always starts a chunk) rather than rejected — a drift of
    one position still yields a legal plan, and the fold/cap validators
    downstream guarantee the structural invariants regardless.
    """
    if not isinstance(breaks, dict):
        return None
    groups: List[dict] = []
    for para in paragraphs:
        p = para["idx"]
        n = len(para.get("sentences") or [])
        # small models echo the prompt's "paragraph N:" label into the key
        mask = breaks.get(str(p), breaks.get(f"paragraph {p}"))
        if not isinstance(mask, str) or not mask:
            return None
        if any(ch not in "01" for ch in mask):
            return None
        mask = mask[:n] if len(mask) > n else mask.ljust(n, "0")
        if n:
            mask = "1" + mask[1:]
        starts = [i for i, ch in enumerate(mask) if ch == "1"]
        for j, s in enumerate(starts):
            e = starts[j + 1] - 1 if j + 1 < len(starts) else n - 1
            groups.append({"para": p, "from": s, "to": e})
    return groups or None


# Response-format ladder, strictest first: json_schema constrains the
# output shape (LM Studio and OpenAI enforce it — bad_json becomes
# impossible), json_object is the older hint, none is the last resort for
# endpoints that reject both. A 400 steps down one rung.
_BREAKS_SCHEMA = {
    "name": "chunk_breaks",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {"breaks": {
            "type": "object",
            "additionalProperties": {"type": "string"},
        }},
        "required": ["breaks"],
        "additionalProperties": False,
    },
}
_RESPONSE_FORMATS = [
    {"type": "json_schema", "json_schema": _BREAKS_SCHEMA},
    {"type": "json_object"},
    None,
]


def _request_completion(client: httpx.Client, messages: List[dict]) -> str:
    body = {"model": config.LLM_MODEL, "temperature": 0, "messages": messages}
    try:
        r = None
        for fmt in _RESPONSE_FORMATS:
            if fmt is None:
                body.pop("response_format", None)
            else:
                body["response_format"] = fmt
            r = client.post(_chat_url(), json=body)
            if r.status_code != 400:
                break                  # answered, or a non-format error
        if r is None or r.status_code != 200:
            raise _LlmError("http_status")
        return _extract_content(r.json())
    except _LlmError:
        raise
    except httpx.TimeoutException:
        raise _LlmError("timeout")
    except httpx.HTTPError:
        raise _LlmError("transport")


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def build_chunks_from_groups(paragraphs: List[dict],
                             groups: list) -> Optional[List[dict]]:
    """Validated model grouping -> plan chunks, or None when unusable.

    Chunk text is built ONLY from the stored sentences with the chunker's
    exact join semantics — a heuristic-identical group then reproduces a
    byte-identical chunk text and keeps its audio.
    """
    if not groups:
        return None
    parsed: List[Tuple[int, int, int]] = []
    for g in groups:
        if not isinstance(g, dict):
            return None
        p, a, b = g.get("para"), g.get("from"), g.get("to")
        if not (_is_int(p) and _is_int(a) and _is_int(b)):
            return None
        parsed.append((p, a, b))

    by_para: dict = {}
    for para in paragraphs:
        texts = [s.get("text", "") for s in para.get("sentences", [])]
        by_para[para["idx"]] = texts

    intervals: dict = {}  # para idx -> [(from, to)]
    for p, a, b in parsed:
        texts = by_para.get(p)
        if texts is None:
            return None                      # unknown (incl. no_tts) para
        if not (0 <= a <= b < len(texts)):
            return None
        intervals.setdefault(p, []).append((a, b))

    for p, spans in intervals.items():
        spans.sort()
        want = 0
        for a, b in spans:
            if a != want:
                return None                  # gap or overlap
            want = b + 1
        if want != len(by_para[p]):
            return None                      # missing tail sentences

    def _text(p: int, a: int, b: int) -> str:
        return " ".join(by_para[p][a:b + 1])

    # soft minimum: fold tiny groups into a same-paragraph neighbour
    for p in list(intervals):
        changed = True
        while changed:
            changed = False
            spans = intervals[p]
            for i, (a, b) in enumerate(spans):
                if len(_text(p, a, b)) >= MIN_CHUNK_CHARS:
                    continue
                prev = spans[i - 1] if i > 0 else None
                nxt = spans[i + 1] if i + 1 < len(spans) else None
                if prev is not None and len(_text(p, prev[0], b)) <= MAX_CHUNK_CHARS:
                    spans[i - 1] = (prev[0], b)
                elif nxt is not None and len(_text(p, a, nxt[1])) <= MAX_CHUNK_CHARS:
                    spans[i + 1] = (a, nxt[1])
                else:
                    continue                 # too big to fold: it stands
                spans.pop(i)
                changed = True
                break

    # hard cap: an oversize group re-cuts by the existing heuristic
    out: List[dict] = []
    for para in paragraphs:                  # document order
        p = para["idx"]
        for a, b in intervals.get(p, []):
            texts = by_para[p][a:b + 1]
            if len(_text(p, a, b)) > MAX_CHUNK_CHARS:
                for s0, s1, piece in chunk_paragraph(texts):
                    out.append({"idx": len(out), "para": p,
                                "sentence_range": [a + s0, a + s1],
                                "text": piece})
            else:
                out.append({"idx": len(out), "para": p,
                            "sentence_range": [a, b], "text": _text(p, a, b)})
    if not out and any(by_para.values()):
        return None                          # had sentences, planned nothing
    return out


def plan_section(section: dict, use_llm: bool, breaker: Breaker,
                 client: Optional[httpx.Client] = None
                 ) -> Tuple[List[dict], int, bool, Optional[str]]:
    """Plan ONE section -> (chunks, total_words, llm_used, fallback_reason).

    Heuristic output is byte-identical to plan_sections([section]).
    """
    speakable = [p for p in section.get("paragraphs", [])
                 if not p.get("no_tts") and p.get("sentences")]
    total_words = sum(len(words_of(s.get("text", "")))
                      for p in speakable for s in p["sentences"])
    reason = "off"
    if use_llm and llm_configured() and speakable and not breaker.open:
        own = client is None
        c = client or make_client()
        try:
            content = _request_completion(c, [
                {"role": "system", "content": _SYSTEM},
                {"role": "user", "content": render_user_message(section)}])
            payload = _loads_content(content)
            if payload and isinstance(payload.get("breaks"), dict):
                # compact shape (what the prompt asks for): mask -> groups
                groups = groups_from_breaks(speakable, payload["breaks"])
            else:
                groups = _parse_groups(content)   # legacy shape, still valid
            if groups is None:
                raise _LlmError("bad_json")
            chunks = build_chunks_from_groups(speakable, groups)
            if chunks is None:
                raise _LlmError("bad_groups")
            breaker.record(True)
            return chunks, total_words, True, None
        except _LlmError as e:
            breaker.record(False)
            reason = e.reason
        finally:
            if own:
                c.close()
    elif use_llm and speakable and breaker.open:
        reason = "breaker"
    planned, _ = plan_sections([section])
    return planned[0]["chunks"], total_words, False, reason


def plan_sections_planned(sections: List[dict], use_llm: bool
                          ) -> Tuple[List[dict], int, dict]:
    """Ingest orchestrator: plan_sections' contract + planner stats."""
    breaker = Breaker(config.LLM_MAX_FAILURES)
    client = make_client() if (use_llm and llm_configured()) else None
    out: List[dict] = []
    total = 0
    llm_sections = 0
    reasons: dict = {}
    try:
        for sec in sections:
            chunks, tw, llm_used, reason = plan_section(sec, use_llm, breaker,
                                                        client=client)
            out.append({"idx": sec["idx"], "title": sec.get("title"),
                        "chunks": chunks})
            total += tw
            if llm_used:
                llm_sections += 1
            elif reason:
                reasons[reason] = reasons.get(reason, 0) + 1
    finally:
        if client is not None:
            client.close()
    stats = {
        "planner": f"llm:{config.LLM_MODEL}" if llm_sections else "heuristic",
        "llm_sections": llm_sections,
        "fallback_sections": len(sections) - llm_sections,
        "fallback_reasons": reasons,
    }
    return out, total, stats

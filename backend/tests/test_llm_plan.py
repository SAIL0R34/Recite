"""LLM chunk planner: validator, client shape, breaker, wiring, routes.

The HTTP layer is httpx.MockTransport throughout — no test touches a real
endpoint, and the configured hosts are obviously fake.
"""
from __future__ import annotations

import json

import httpx
import pytest

from app import config
from app.ingest import llm_plan
from app.ingest.chunker import MAX_CHUNK_CHARS, plan_sections

# ------------------------------------------------------------ fixtures

PARAS = [{
    "idx": 0, "no_tts": False,
    "sentences": [{"text": "One one one."},
                  {"text": "Two two two, with a clause."},
                  {"text": "Three."}],
}, {
    "idx": 1, "no_tts": False,
    "sentences": [{"text": "Four."}],
}]

SECTION = {"idx": 0, "title": "S", "paragraphs": PARAS}


@pytest.fixture()
def llm_env(monkeypatch):
    monkeypatch.setattr(config, "LLM_BASE_URL", "http://llm.test")
    monkeypatch.setattr(config, "LLM_API_KEY", "sk-test")
    monkeypatch.setattr(config, "LLM_MODEL", "test-model")
    monkeypatch.setattr(config, "LLM_TIMEOUT_S", 5.0)
    monkeypatch.setattr(config, "LLM_MAX_FAILURES", 3)


def mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def ok_content(groups) -> str:
    return json.dumps({"groups": groups})


def ok_response(groups) -> httpx.Response:
    return httpx.Response(200, json={"choices": [
        {"message": {"content": ok_content(groups)}}]})


def breaks_response(breaks) -> httpx.Response:
    """The compact shape the prompt asks for (one char per sentence)."""
    return httpx.Response(200, json={"choices": [
        {"message": {"content": json.dumps({"breaks": breaks})}}]})


def section_with(texts):
    return {"idx": 0, "title": "S", "paragraphs": [
        {"idx": 0, "no_tts": False, "sentences": [{"text": t} for t in texts]}]}


def plan_via(section, handler, llm_env=None):  # noqa: ARG001
    breaker = llm_plan.Breaker(3)
    return llm_plan.plan_section(section, True, breaker,
                                 client=mock_client(handler))


# ------------------------------------------------------------ validator

def test_validator_builds_exact_texts():
    chunks = llm_plan.build_chunks_from_groups(
        PARAS, [{"para": 0, "from": 0, "to": 1}, {"para": 0, "from": 2, "to": 2},
                {"para": 1, "from": 0, "to": 0}])
    assert chunks is not None
    # "Three." (6 chars) folds into its same-paragraph neighbour — the soft
    # minimum at work; "Four." cannot fold across the paragraph wall
    assert [c["text"] for c in chunks] == [
        "One one one. Two two two, with a clause. Three.", "Four."]
    assert [c["para"] for c in chunks] == [0, 1]
    assert [c["sentence_range"] for c in chunks] == [[0, 2], [0, 0]]
    assert [c["idx"] for c in chunks] == [0, 1]


def test_validator_rejects_gap():
    assert llm_plan.build_chunks_from_groups(
        PARAS, [{"para": 0, "from": 0, "to": 0},
                {"para": 0, "from": 2, "to": 2}]) is None


def test_validator_rejects_overlap():
    assert llm_plan.build_chunks_from_groups(
        PARAS, [{"para": 0, "from": 0, "to": 1},
                {"para": 0, "from": 1, "to": 2}]) is None


def test_validator_rejects_out_of_range():
    assert llm_plan.build_chunks_from_groups(
        PARAS, [{"para": 0, "from": 0, "to": 3}]) is None
    assert llm_plan.build_chunks_from_groups(
        PARAS, [{"para": 0, "from": -1, "to": 2}]) is None


def test_validator_rejects_unknown_para():
    assert llm_plan.build_chunks_from_groups(
        PARAS, [{"para": 9, "from": 0, "to": 0}]) is None


def test_validator_rejects_non_int_fields():
    for bad in ({"para": "0", "from": 0, "to": 2},
                {"para": 0, "from": 0.0, "to": 2},
                {"para": 0, "from": 0, "to": True}):
        assert llm_plan.build_chunks_from_groups(PARAS, [bad]) is None
    assert llm_plan.build_chunks_from_groups(PARAS, [{}]) is None
    assert llm_plan.build_chunks_from_groups(PARAS, []) is None


def test_validator_tolerates_scrambled_order():
    chunks = llm_plan.build_chunks_from_groups(
        PARAS, [{"para": 0, "from": 2, "to": 2}, {"para": 1, "from": 0, "to": 0},
                {"para": 0, "from": 0, "to": 1}])
    assert chunks is not None
    assert chunks[0]["sentence_range"] == [0, 2]  # folded, but starts first


def test_validator_recuts_oversize_group():
    longs = [f"Word {i} keeps going and going." for i in range(20)]  # >300 chars
    chunks = llm_plan.build_chunks_from_groups(
        section_with(longs)["paragraphs"],
        [{"para": 0, "from": 0, "to": len(longs) - 1}])
    assert chunks is not None and len(chunks) > 1
    assert all(len(c["text"]) <= MAX_CHUNK_CHARS for c in chunks)
    # ranges stay sentence-aligned and cover everything
    assert chunks[0]["sentence_range"][0] == 0
    assert chunks[-1]["sentence_range"][1] == len(longs) - 1


def test_validator_leaves_single_long_sentence_whole():
    one = " ".join(f"w{i}" for i in range(120)) + "."   # one ~500-char sentence
    chunks = llm_plan.build_chunks_from_groups(
        section_with([one])["paragraphs"], [{"para": 0, "from": 0, "to": 0}])
    assert chunks is not None and len(chunks) == 1  # the heuristic's own exception


def test_validator_folds_tiny_group_into_previous():
    chunks = llm_plan.build_chunks_from_groups(
        PARAS, [{"para": 0, "from": 0, "to": 0}, {"para": 0, "from": 1, "to": 1},
                {"para": 0, "from": 2, "to": 2}, {"para": 1, "from": 0, "to": 0}])
    assert chunks is not None
    texts = [c["text"] for c in chunks]
    assert "Three." not in texts            # folded into its neighbour
    assert texts[-1] == "Four."             # cross-paragraph: never folded


def test_validator_refuses_fold_past_cap():
    big = "x" * 298 + "."                    # 299 alone; 305 with the neighbour
    sec = section_with([big, "Tiny."])
    chunks = llm_plan.build_chunks_from_groups(
        sec["paragraphs"], [{"para": 0, "from": 0, "to": 0},
                            {"para": 0, "from": 1, "to": 1}])
    assert chunks is not None
    assert chunks[-1]["text"] == "Tiny."    # joining would exceed the cap


# ------------------------------------------------------------ client

def test_breaks_shape_plans_chunks(llm_env):
    # para 0: chunk at 0..1, then 2 alone; para 1: single chunk
    def handler(_r):
        return breaks_response({"0": "110", "1": "1"})

    chunks, _tw, used, reason = plan_via(SECTION, handler)
    assert used is True and reason is None
    # "Three." folds in, exactly like the groups path
    assert [c["text"] for c in chunks] == [
        "One one one. Two two two, with a clause. Three.", "Four."]


@pytest.mark.parametrize("breaks", [
    {"0": "1o0", "1": "1"},       # non-binary character
    {"1": "1"},                   # missing paragraph mask
    {"0": "110"},
    {"0": "", "1": "1"},          # empty mask
])
def test_breaks_shape_rejects_malformed_masks(llm_env, breaks):
    def handler(_r):
        return breaks_response(breaks)

    chunks, _tw, used, reason = plan_via(SECTION, handler)
    assert used is False
    assert reason in ("bad_json", "bad_groups")
    assert chunks  # heuristic fallback produced a plan


def test_breaks_repairs_sloppy_lengths(llm_env):
    def handler(_r):
        # para 0 has 3 sentences: mask too long (clamped) + leading 0 fixed;
        # para 1 has 1 sentence: mask too short (tail extends the chunk)
        return breaks_response({"0": "0100101", "1": "11"})

    chunks, _tw, used, reason = plan_via(SECTION, handler)
    assert used is True and reason is None
    # para 0 repaired to "100" -> chunk [0,2], folded; para 1 to "1"
    assert [c["sentence_range"] for c in chunks] == [[0, 2], [0, 0]]


def test_breaks_ignores_unknown_paragraph_keys(llm_env):
    def handler(_r):
        return breaks_response({"0": "111", "1": "1", "99": "1"})

    _chunks, _tw, used, reason = plan_via(SECTION, handler)
    assert used is True and reason is None


def test_breaks_tolerates_paragraph_label_keys(llm_env):
    def handler(_r):
        # small models echo the prompt's "paragraph N:" label into the key
        return breaks_response({"paragraph 0": "111", "paragraph 1": "1"})

    _chunks, _tw, used, reason = plan_via(SECTION, handler)
    assert used is True and reason is None


def test_make_client_carries_the_bearer(llm_env):
    c = llm_plan.make_client()
    assert c.headers["Authorization"] == "Bearer sk-test"


def test_request_shape(llm_env):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        seen["body"] = json.loads(request.content)
        return ok_response([{"para": 0, "from": 0, "to": 2},
                            {"para": 1, "from": 0, "to": 0}])

    # the client make_client() would build, on a mock transport
    c = httpx.Client(timeout=config.LLM_TIMEOUT_S,
                     headers={"Authorization": "Bearer sk-test"},
                     transport=httpx.MockTransport(handler))
    chunks, _tw, used, reason = llm_plan.plan_section(
        SECTION, True, llm_plan.Breaker(3), client=c)
    assert used is True and reason is None
    assert seen["url"] == "http://llm.test/v1/chat/completions"
    assert seen["auth"] == "Bearer sk-test"
    assert seen["body"]["model"] == "test-model"
    assert seen["body"]["temperature"] == 0
    assert seen["body"]["response_format"] == {
        "type": "json_schema", "json_schema": llm_plan._BREAKS_SCHEMA}
    assert chunks[0]["text"].endswith("Three.")  # tiny group folded in


def test_url_dedupes_v1_suffix(llm_env, monkeypatch):
    monkeypatch.setattr(config, "LLM_BASE_URL", "http://llm.test/v1")
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return ok_response([{"para": 0, "from": 0, "to": 2},
                            {"para": 1, "from": 0, "to": 0}])

    plan_via(SECTION, handler)
    assert seen["url"] == "http://llm.test/v1/chat/completions"


def test_no_auth_header_without_key(llm_env, monkeypatch):
    monkeypatch.setattr(config, "LLM_API_KEY", "")

    def handler(request: httpx.Request) -> httpx.Response:
        assert "Authorization" not in request.headers
        return ok_response([{"para": 0, "from": 0, "to": 2},
                            {"para": 1, "from": 0, "to": 0}])

    _chunks, _tw, used, _reason = plan_via(SECTION, handler)
    assert used is True


def test_400_steps_down_the_format_ladder(llm_env):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body.get("response_format"))
        if len(calls) <= 2:                 # json_schema and json_object rejected
            return httpx.Response(400, json={"error": "bad param"})
        return ok_response([{"para": 0, "from": 0, "to": 2},
                            {"para": 1, "from": 0, "to": 0}])

    chunks, _tw, used, _reason = plan_via(SECTION, handler)
    assert used is True
    assert [c.get("type") if c else None for c in calls] == \
        ["json_schema", "json_object", None]


def test_json_schema_is_tried_first(llm_env):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content).get("response_format"))
        return ok_response([{"para": 0, "from": 0, "to": 2},
                            {"para": 1, "from": 0, "to": 0}])

    plan_via(SECTION, handler)
    assert calls == [{"type": "json_schema", "json_schema": llm_plan._BREAKS_SCHEMA}]


def test_think_blocks_are_stripped_before_parsing(llm_env):
    def handler(_r):
        content = ("<think>hmm let me consider paragraph structure</think>"
                   + ok_content([{"para": 0, "from": 0, "to": 2},
                                 {"para": 1, "from": 0, "to": 0}]))
        return httpx.Response(200, json={"choices": [
            {"message": {"content": content}}]})

    _chunks, _tw, used, reason = plan_via(SECTION, handler)
    assert used is True and reason is None


def test_fenced_json_tolerated(llm_env):
    def handler(_request: httpx.Request) -> httpx.Response:
        content = "```json\n" + ok_content(
            [{"para": 0, "from": 0, "to": 2},
             {"para": 1, "from": 0, "to": 0}]) + "\n```"
        return httpx.Response(200, json={"choices": [
            {"message": {"content": content}}]})

    _chunks, _tw, used, _reason = plan_via(SECTION, handler)
    assert used is True


@pytest.mark.parametrize("make_response,reason", [
    (lambda: (_ for _ in ()).throw(httpx.ConnectTimeout("t")), "timeout"),
    (lambda: httpx.Response(500, json={}), "http_status"),
    (lambda: httpx.Response(200, json={"choices": []}), "bad_response"),
    (lambda: httpx.Response(200, json={"choices": [
        {"message": {"content": "sure! no json here"}}]}), "bad_json"),
    (lambda: ok_response([{"para": 0, "from": 0, "to": 0}]), "bad_groups"),
])
def test_failures_fall_back_with_reasons(llm_env, make_response, reason):
    def handler(_request: httpx.Request) -> httpx.Response:
        out = make_response()
        return out

    chunks, tw, used, why = plan_via(SECTION, handler)
    assert used is False and why == reason
    expected, _ = plan_sections([SECTION])
    assert chunks == expected[0]["chunks"]  # byte-identical heuristic plan
    assert tw == sum(len(t.split()) for p in PARAS for t in
                     [s["text"] for s in p["sentences"]])


def test_unconfigured_makes_no_calls(llm_env, monkeypatch):
    monkeypatch.setattr(config, "LLM_BASE_URL", "")
    monkeypatch.setattr(config, "LLM_MODEL", "")
    assert llm_plan.llm_configured() is False

    def boom():
        raise AssertionError("no client may be created unconfigured")

    monkeypatch.setattr(llm_plan, "make_client", boom)
    secs = [SECTION, {"idx": 1, "title": "T", "paragraphs": [PARAS[0]]}]
    out, _tw, stats = llm_plan.plan_sections_planned(secs, True)
    assert stats["planner"] == "heuristic"
    assert stats["llm_sections"] == 0
    expected, _ = plan_sections(secs)
    assert out == expected


# ------------------------------------------------------------ breaker

def _stub_client(monkeypatch, handler):
    calls = []

    def counting_handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    monkeypatch.setattr(llm_plan, "make_client",
                        lambda: mock_client(counting_handler))
    return calls


def test_breaker_opens_after_consecutive_failures(llm_env, monkeypatch):
    monkeypatch.setattr(config, "LLM_MAX_FAILURES", 2)
    calls = _stub_client(
        monkeypatch, lambda _r: httpx.Response(500, json={}))
    secs = [dict(SECTION, idx=i) for i in range(4)]
    out, _tw, stats = llm_plan.plan_sections_planned(secs, True)
    assert len(calls) == 2                       # then the breaker opened
    assert stats["fallback_reasons"] == {"http_status": 2, "breaker": 2}
    assert stats["planner"] == "heuristic"


def test_success_resets_the_streak(llm_env, monkeypatch):
    monkeypatch.setattr(config, "LLM_MAX_FAILURES", 3)
    state = {"n": 0}

    def handler(_r):
        state["n"] += 1
        if state["n"] % 2 == 1:
            return httpx.Response(500, json={})
        return ok_response([{"para": 0, "from": 0, "to": 2},
                            {"para": 1, "from": 0, "to": 0}])

    calls = _stub_client(monkeypatch, handler)
    secs = [dict(SECTION, idx=i) for i in range(5)]
    _out, _tw, stats = llm_plan.plan_sections_planned(secs, True)
    assert len(calls) == 5                       # never opened
    assert stats["llm_sections"] == 2
    assert stats["planner"] == "llm:test-model"


def test_mixed_stats(llm_env, monkeypatch):
    state = {"n": 0}

    def handler(_r):
        state["n"] += 1
        if state["n"] == 1:
            return httpx.Response(500, json={})
        return ok_response([{"para": 0, "from": 0, "to": 2},
                            {"para": 1, "from": 0, "to": 0}])

    _stub_client(monkeypatch, handler)
    secs = [dict(SECTION, idx=i) for i in range(2)]
    _out, _tw, stats = llm_plan.plan_sections_planned(secs, True)
    assert stats["llm_sections"] == 1
    assert stats["fallback_sections"] == 1
    assert stats["fallback_reasons"] == {"http_status": 1}


# ------------------------------------------------------------ rechunk wiring

def _write_fake_book(book_id):
    doc = {
        "title": "T",
        "sections": [{
            "idx": 0, "title": "S0",
            "paragraphs": [
                {"idx": 0, "no_tts": False,
                 "sentences": [{"text": "First sentence here."}]},
                {"idx": 1, "no_tts": False,
                 "sentences": [{"text": "And everyone is"}]},
                {"idx": 2, "no_tts": False,
                 "sentences": [{"text": "watching this test."}]},
            ],
        }],
    }
    (config.book_dir(book_id)).mkdir(parents=True, exist_ok=True)
    config.book_file(book_id, "document.json").write_text(
        json.dumps(doc), encoding="utf-8")
    manifest = {
        "engine": "kokoro", "voice": "af_heart", "alignment": "ready",
        "rule_version": 1,
        "sections": [{
            "idx": 0, "title": "S0", "audio": "audio/section-000.mp3",
            "duration_ms": 5000, "status": "ready", "tts": True,
            "chunks": [
                {"idx": 0, "section": 0, "para": 0,
                 "sentence_range": [0, 0], "text": "First sentence here.",
                 "global_start_ms": 0, "duration_ms": 1000,
                 "status": "ready",
                 "words": [[0, 0, 300, "First"], [4, 0, 700, "sentence"]]},
            ],
        }],
    }
    manifestio.save(book_id, manifest)
    mp3 = config.book_file(book_id, "audio/section-000.mp3")
    mp3.parent.mkdir(parents=True, exist_ok=True)
    mp3.write_bytes(b"ID3fake")
    return doc


from app import manifestio  # noqa: E402  (after conftest's sys.path setup)
from app.ingest.rechunk import rechunk_book, recheck_all  # noqa: E402


def smart_groups_handler(request: httpx.Request) -> httpx.Response:
    """Return one full-coverage group per paragraph, derived from the
    rendered prompt — valid for any section shape."""
    user = json.loads(request.content)["messages"][1]["content"]
    groups, cur, count = [], None, 0
    for line in user.splitlines():
        if line.startswith("paragraph "):
            if cur is not None:
                groups.append({"para": cur, "from": 0, "to": count - 1})
            cur, count = int(line.split()[1].rstrip(":")), 0
        elif cur is not None and line[:1].isdigit():
            count += 1
    if cur is not None:
        groups.append({"para": cur, "from": 0, "to": count - 1})
    return ok_response(groups)


def test_rechunk_llm_keeps_audio_and_stamps(llm_env, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR_PATH", tmp_path / "books")
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "recite.db")
    _stub_client(monkeypatch, smart_groups_handler)
    bid = "llm-rechunk"
    _write_fake_book(bid)
    r = rechunk_book(bid, planner="llm")
    assert r["planner"] == "llm:test-model"
    assert r["llm_sections"] == 1
    assert r["kept"] == 1          # para 0's text unchanged -> audio kept
    assert r["sections_reset"] == 1  # stitched paras moved
    m = manifestio.load(bid)
    assert m["planner"] == "llm:test-model"
    assert m["rule_version"] == 2


def test_rechunk_forced_heuristic_never_calls(llm_env, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR_PATH", tmp_path / "books")
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "recite.db")
    calls = _stub_client(monkeypatch, smart_groups_handler)
    bid = "heur-rechunk"
    _write_fake_book(bid)
    r = rechunk_book(bid, planner="heuristic")
    assert calls == []
    assert r["planner"] == "heuristic"


def test_recheck_all_is_heuristic_only(llm_env, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR_PATH", tmp_path / "books")
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "recite.db")
    calls = _stub_client(monkeypatch, smart_groups_handler)
    bid = "sweep-book"
    _write_fake_book(bid)               # rule_version 1 -> needs_rechunk
    out = recheck_all()
    assert calls == []                  # the sweep never spends quota
    assert any(r["book_id"] == bid for r in out)
    assert manifestio.load(bid)["planner"] == "heuristic"


def test_init_manifest_stamps_rule_version(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "BOOKS_DIR_PATH", tmp_path / "books")
    m = manifestio.init_manifest("stampy", sections=[], engine="kokoro",
                                 voice="af_heart", planner="llm:test-model")
    assert m["planner"] == "llm:test-model"
    assert m["rule_version"] == 2
    from app.ingest.rechunk import needs_rechunk
    assert needs_rechunk(m) is False    # a fresh LLM book survives restart


# ------------------------------------------------------------ routes

@pytest.fixture()
def client(tmp_path, monkeypatch, llm_env):
    monkeypatch.setattr(config, "LLM_API_KEY", "sk-secret")
    from app.db import Database
    import app.api.books as books_mod

    db = Database(tmp_path / "test.db")
    db.init()
    db.add_book("b1", "p.pdf", "Test Book", "A. Author", "pdf", [], 100)
    monkeypatch.setattr(books_mod, "db", db)

    from app.main import app
    from fastapi.testclient import TestClient
    yield TestClient(app)


def test_get_api_llm_masks_key(client):
    r = client.get("/api/llm")
    assert r.status_code == 200
    body = r.json()
    assert body == {"configured": True, "model": "test-model",
                    "base": "http://llm.test"}
    assert "sk-secret" not in r.text


def test_rechunk_route_planner_param(client, monkeypatch):
    import app.ingest.rechunk as rechunk_mod

    seen = {}

    def fake(book_id, planner="auto"):
        seen["planner"] = planner
        return {"sections_total": 0, "planner": "heuristic"}

    monkeypatch.setattr(rechunk_mod, "rechunk_book", fake)
    assert client.post("/api/books/b1/rechunk?planner=heuristic").status_code == 200
    assert seen["planner"] == "heuristic"
    assert client.post("/api/books/b1/rechunk?planner=nope").status_code == 422

import json, os, tempfile
os.environ["RECITE_DATA_DIR"] = tempfile.mkdtemp()
import sys; sys.path.insert(0, "backend")
from app import config, manifestio
from app.ingest import rechunk as R

doc = {
    "title": "T",
    "sections": [{
        "idx": 0, "title": "S0",
        "paragraphs": [
            {"idx": 0, "no_tts": False, "text": "First sentence here."},
            {"idx": 1, "no_tts": False, "text": "And everyone is"},
            {"idx": 2, "no_tts": False, "text": "watching this test."},
        ]}]
}
bid = "dbg"
config.book_dir(bid).mkdir(parents=True, exist_ok=True)
config.book_file(bid, "document.json").write_text(json.dumps(doc))
manifestio.save(bid, {
    "engine": "k", "voice": "v", "alignment": "ready", "created_at": 0,
    "sections": [{
        "idx": 0, "title": "S0", "audio": "audio/section-000.mp3",
        "duration_ms": 5000, "status": "ready", "tts": True,
        "chunks": [
            {"idx": 0, "section": 0, "para": 0, "sentence_range": [0, 0],
             "text": "First sentence here.", "global_start_ms": 0,
             "duration_ms": 1000, "status": "ready",
             "words": [[0, 0, 300, "First"]]},
        ]}]})
secs, no_tts = R._doc_to_sections(doc)
print("no_tts:", no_tts)
print("section paras:", [(len(s.paragraphs), [p.no_tts for p in s.paragraphs],
                          [ [x.text for x in p.sentences] for p in s.paragraphs]) for s in secs])
out, rep = R.plan_new_sections(manifestio.load(bid)["sections"], secs, no_tts)
print("report:", rep)
print(json.dumps([{k: v for k, v in s.items() if k != "chunks"} for s in out], indent=1))
for c in out[0]["chunks"]:
    print({k: c.get(k) for k in ("idx","para","sentence_range","text","status","global_start_ms")})

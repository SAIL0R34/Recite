"""Why did stored sentences break mid-clause? Re-split a bad paragraph."""
import json
import os
import sys
from pathlib import Path

if len(sys.argv) < 2:
    raise SystemExit(f"usage: {sys.argv[0]} BOOK_ID [SECTION_IDX]")
book_id = sys.argv[1]
section_idx = int(sys.argv[2]) if len(sys.argv) > 2 else 1

data_dir = Path(os.environ.get(
    "RECITE_DATA_DIR",
    Path.home() / "Library" / "Application Support" / "recite"))
doc = json.loads(
    (data_dir / "books" / book_id / "document.json").read_text("utf-8"))
sec = next(s for s in doc["sections"] if s["idx"] == section_idx)
p = sec["paragraphs"][0]
joined = " ".join(s["text"] for s in p["sentences"])
print("stored sentences:", [s["text"] for s in p["sentences"]])

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from app.ingest.model import split_sentences
print("re-split now:  ", split_sentences(joined))

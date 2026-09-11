"""Why did stored sentences break mid-clause? Re-split a bad paragraph."""
import json

base = "$RECITE_DATA_DIR/books"
doc = json.load(open(f"{base}/BOOK_ID/document.json"))
sec = next(s for s in doc["sections"] if s["idx"] == 1)
p = sec["paragraphs"][0]
joined = " ".join(s["text"] for s in p["sentences"])
print("stored sentences:", [s["text"] for s in p["sentences"]])
import sys
sys.path.insert(0, ".//backend")
from app.ingest.model import split_sentences
print("re-split now:  ", split_sentences(joined))

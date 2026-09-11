"""Read-only: confirm startup rechunk stamped rule_version and queued work."""
import json
from pathlib import Path

ROOT = Path.home() / "Library/Application Support/recite/books"
for mf in sorted(ROOT.glob("*/manifest.json")):
    if mf.parent.name == "testbook":
        continue
    m = json.loads(mf.read_text())
    secs = m.get("sections", [])
    ready = sum(1 for s in secs if s.get("status") == "ready")
    pend = sum(1 for s in secs if s.get("status") == "pending")
    tts = [s for s in secs if s.get("tts")]
    print(f"{mf.parent.name}: rule_version={m.get('rule_version', 'MISSING')} "
          f"sections={len(secs)} tts={len(tts)} ready={ready} pending={pend}")
    # every stored chunk must end on a blessed punctuation mark
    bad = total = 0
    for s in secs:
        for c in s.get("chunks", []):
            t = (c.get("text") or "").strip()
            if not t:
                continue
            total += 1
            core = t.rstrip('"’”)]')
            if core and core[-1] not in '.,!?\u2014:;':
                bad += 1
                if bad <= 3:
                    print("  BAD ENDING:", repr(t[-60:]))
    print(f"  chunks={total} bad_endings={bad}")


"""Make the backend package importable as ``app`` without installing it, and
keep every test off the real library: RECITE_DATA_DIR must be set before
app.config is first imported, since db binds its path at import time."""
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

if "RECITE_DATA_DIR" not in os.environ:
    os.environ["RECITE_DATA_DIR"] = tempfile.mkdtemp(prefix="recite-tests-")

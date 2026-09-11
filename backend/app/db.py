"""Single write path for SQLite (WAL). All callers go through `db` below.

Concurrency story: WAL + a threading.Lock around the single connection.
Reads in api handlers use `read()` which shares the same lock — cheap at
our scale and immune to surprise interleavings from worker threads.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from typing import Any, Optional

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS books(
  id TEXT PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ingesting',   -- ingesting|ready|failed
  warnings TEXT,                              -- JSON array of strings
  total_words INTEGER DEFAULT 0,
  created_at REAL,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS progress(
  book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  section_idx INTEGER DEFAULT 0,
  word_idx INTEGER DEFAULT 0,
  ms_into_section INTEGER DEFAULT 0,
  percent REAL DEFAULT 0,
  updated_at REAL
);
CREATE TABLE IF NOT EXISTS bookmarks(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  name TEXT,
  section_idx INTEGER NOT NULL,
  ms REAL NOT NULL,
  created_at REAL
);
CREATE TABLE IF NOT EXISTS highlights(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  section_idx INTEGER NOT NULL,
  para_idx INTEGER NOT NULL,
  start_ti INTEGER NOT NULL,
  end_ti INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT 'amber',
  text TEXT DEFAULT '',
  created_at REAL
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS bookmarks_book ON bookmarks(book_id);
CREATE INDEX IF NOT EXISTS highlights_book ON highlights(book_id);
"""

#: columns added after the first release (ALTER, not CREATE) — idempotent
_MIGRATIONS = [
    "ALTER TABLE progress ADD COLUMN active INTEGER DEFAULT 0",
    "ALTER TABLE progress ADD COLUMN section_start_ms INTEGER DEFAULT 0",
]


class Database:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._conn: Optional[sqlite3.Connection] = None

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def init(self) -> None:
        with self._lock:
            self._conn = self._connect()
            self._conn.executescript(SCHEMA)
            for ddl in _MIGRATIONS:
                try:
                    self._conn.execute(ddl)
                except sqlite3.OperationalError:
                    pass           # column already exists
            self._conn.commit()

    # ---------------------------------------------------------- books
    def add_book(self, book_id: str, path: str, title: str, author: str, fmt: str,
                 warnings: list, total_words: int) -> dict:
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO books(id,path,title,author,format,status,warnings,total_words,created_at,updated_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (book_id, path, title, author, fmt, "ready",
                 json.dumps(warnings), total_words, now, now))
            self._conn.commit()
        return self.get_book(book_id)

    def get_book(self, book_id: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
        return dict(row) if row else None

    def list_books(self) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT b.*, COALESCE(p.percent,0) AS percent FROM books b"
                " LEFT JOIN progress p ON p.book_id=b.id ORDER BY b.updated_at DESC").fetchall()
        return [dict(r) for r in rows]

    def find_book_by_path(self, path: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM books WHERE path=?", (path,)).fetchone()
        return dict(row) if row else None

    def update_book_status(self, book_id: str, status: str,
                           warnings: Optional[list] = None,
                           total_words: Optional[int] = None) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE books SET status=?, updated_at=?" 
                + (", warnings=?" if warnings is not None else "")
                + (", total_words=?" if total_words is not None else "")
                + " WHERE id=?",
                ([status, time.time()]
                 + ([json.dumps(warnings)] if warnings is not None else [])
                 + ([total_words] if total_words is not None else [])
                 + [book_id]))
            self._conn.commit()

    def delete_book(self, book_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM books WHERE id=?", (book_id,))
            self._conn.execute("DELETE FROM progress WHERE book_id=?", (book_id,))
            self._conn.execute("DELETE FROM bookmarks WHERE book_id=?", (book_id,))
            self._conn.commit()

    # ------------------------------------------------------- progress
    def get_progress(self, book_id: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute("SELECT * FROM progress WHERE book_id=?", (book_id,)).fetchone()
        return dict(row) if row else None

    def set_progress(self, book_id: str, section_idx: int, word_idx: int,
                     ms_into_section: int, percent: float,
                     active: int = 0, section_start_ms: int = 0) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO progress(book_id,section_idx,word_idx,"
                "ms_into_section,percent,updated_at,active,section_start_ms)"
                " VALUES(?,?,?,?,?,?,?,?)"
                " ON CONFLICT(book_id) DO UPDATE SET section_idx=excluded.section_idx,"
                " word_idx=excluded.word_idx, ms_into_section=excluded.ms_into_section,"
                " percent=excluded.percent, updated_at=excluded.updated_at,"
                " active=excluded.active, section_start_ms=excluded.section_start_ms",
                (book_id, section_idx, word_idx, ms_into_section, percent,
                 time.time(), 1 if active else 0, section_start_ms))
            self._conn.commit()

    # ------------------------------------------------------ bookmarks
    def list_bookmarks(self, book_id: str) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM bookmarks WHERE book_id=? ORDER BY created_at", (book_id,)).fetchall()
        return [dict(r) for r in rows]

    def add_bookmark(self, book_id: str, name: str, section_idx: int, ms: float) -> dict:
        rec = {"id": uuid.uuid4().hex[:10], "book_id": book_id, "name": name,
               "section_idx": section_idx, "ms": ms, "created_at": time.time()}
        with self._lock:
            self._conn.execute(
                "INSERT INTO bookmarks(id,book_id,name,section_idx,ms,created_at) VALUES(?,?,?,?,?,?)",
                (rec["id"], book_id, name, section_idx, ms, rec["created_at"]))
            self._conn.commit()
        return rec

    def delete_bookmark(self, bookmark_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM bookmarks WHERE id=?", (bookmark_id,))
            self._conn.commit()

    # ------------------------------------------------------ highlights
    def list_highlights(self, book_id: str) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM highlights WHERE book_id=? ORDER BY created_at", (book_id,)).fetchall()
        return [dict(r) for r in rows]

    def add_highlight(self, book_id: str, section_idx: int, para_idx: int,
                      start_ti: int, end_ti: int, color: str, text: str) -> dict:
        rec = {"id": uuid.uuid4().hex[:10], "book_id": book_id,
               "section_idx": section_idx, "para_idx": para_idx,
               "start_ti": start_ti, "end_ti": end_ti, "color": color,
               "text": text, "created_at": time.time()}
        with self._lock:
            self._conn.execute(
                "INSERT INTO highlights(id,book_id,section_idx,para_idx,start_ti,end_ti,color,text,created_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (rec["id"], book_id, section_idx, para_idx, start_ti, end_ti,
                 color, text, rec["created_at"]))
            self._conn.commit()
        return rec

    def delete_highlight(self, highlight_id: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM highlights WHERE id=?", (highlight_id,))
            self._conn.commit()

    # ------------------------------------------------------ settings
    def get_settings(self) -> dict:
        out = dict(config.DEFAULT_SETTINGS)
        with self._lock:
            for r in self._conn.execute("SELECT key,value FROM settings"):
                try:
                    out[r["key"]] = json.loads(r["value"])
                except json.JSONDecodeError:
                    out[r["key"]] = r["value"]
        return out

    def set_settings(self, values: dict) -> dict:
        with self._lock:
            for k, v in values.items():
                self._conn.execute(
                    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    (k, json.dumps(v)))
            self._conn.commit()
        return self.get_settings()


db = Database(config.DB_PATH)

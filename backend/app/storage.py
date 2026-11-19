from __future__ import annotations

import gzip
import json
import sqlite3
import threading
import zlib
from datetime import datetime, timezone
from pathlib import Path

from app.models import CrawlGraphResponse, SavedCrawlMeta

DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "webgraph.db"


class CrawlStorage:
    """Persistent, zlib-compressed SQLite storage for completed crawl snapshots."""

    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS saved_crawls (
                    job_id TEXT PRIMARY KEY,
                    seed_url TEXT NOT NULL,
                    graph_mode TEXT NOT NULL,
                    status TEXT NOT NULL,
                    max_depth INTEGER NOT NULL,
                    pages_crawled INTEGER NOT NULL,
                    nodes_count INTEGER NOT NULL,
                    edges_count INTEGER NOT NULL,
                    compressed_bytes INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    payload_zlib BLOB NOT NULL
                )
                """
            )
            self._conn.commit()

    def save_crawl(self, snapshot: CrawlGraphResponse) -> SavedCrawlMeta:
        summary = snapshot.summary
        compact_json = json.dumps(
            snapshot.model_dump(),
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        compressed = zlib.compress(compact_json, level=6)
        created_at = datetime.now(timezone.utc).isoformat()

        with self._lock:
            self._conn.execute(
                """
                INSERT INTO saved_crawls (
                    job_id, seed_url, graph_mode, status, max_depth,
                    pages_crawled, nodes_count, edges_count,
                    compressed_bytes, created_at, payload_zlib
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    status = excluded.status,
                    pages_crawled = excluded.pages_crawled,
                    nodes_count = excluded.nodes_count,
                    edges_count = excluded.edges_count,
                    compressed_bytes = excluded.compressed_bytes,
                    payload_zlib = excluded.payload_zlib
                """,
                (
                    summary.job_id,
                    summary.seed_url,
                    summary.graph_mode,
                    summary.status,
                    summary.max_depth,
                    summary.pages_crawled,
                    summary.nodes_count,
                    summary.edges_count,
                    len(compressed),
                    created_at,
                    compressed,
                ),
            )
            self._conn.commit()

        return SavedCrawlMeta(
            job_id=summary.job_id,
            seed_url=summary.seed_url,
            graph_mode=summary.graph_mode,
            status=summary.status,
            max_depth=summary.max_depth,
            pages_crawled=summary.pages_crawled,
            nodes_count=summary.nodes_count,
            edges_count=summary.edges_count,
            compressed_bytes=len(compressed),
            created_at=created_at,
        )

    def list_crawls(self, limit: int = 50) -> list[SavedCrawlMeta]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT job_id, seed_url, graph_mode, status, max_depth,
                       pages_crawled, nodes_count, edges_count,
                       compressed_bytes, created_at
                FROM saved_crawls
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [SavedCrawlMeta(**dict(row)) for row in rows]

    def get_raw_json_bytes(self, job_id: str) -> bytes | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT payload_zlib FROM saved_crawls WHERE job_id = ?",
                (job_id,),
            ).fetchone()
        if row is None:
            return None
        return zlib.decompress(row["payload_zlib"])

    def get_gzip_bytes(self, job_id: str) -> bytes | None:
        raw = self.get_raw_json_bytes(job_id)
        if raw is None:
            return None
        return gzip.compress(raw, compresslevel=6)

    def get_crawl(self, job_id: str) -> CrawlGraphResponse | None:
        raw = self.get_raw_json_bytes(job_id)
        if raw is None:
            return None
        data = json.loads(raw.decode("utf-8"))
        return CrawlGraphResponse.model_validate(data)

    def delete_crawl(self, job_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM saved_crawls WHERE job_id = ?",
                (job_id,),
            )
            self._conn.commit()
            return cur.rowcount > 0

    def close(self) -> None:
        with self._lock:
            self._conn.close()

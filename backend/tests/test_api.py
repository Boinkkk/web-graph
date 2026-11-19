from __future__ import annotations

import gzip
import json
from pathlib import Path

import httpx
import pytest

from app import main as main_module
from app.main import app, crawl_manager
from app.storage import CrawlStorage


@pytest.mark.asyncio
async def test_health_endpoint() -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.get("/api/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_start_crawl_empty_url_returns_422() -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        resp = await client.post("/api/crawl", json={"url": "   "})
        assert resp.status_code == 422


@pytest.mark.asyncio
async def test_post_crawl_stream_and_snapshot() -> None:
    pages = {
        "https://demo.local/": (
            200,
            '<html><head><title>Demo Home</title></head><body><a href="/page1">P1</a></body></html>',
        ),
        "https://demo.local/page1": (
            200,
            '<html><head><title>Page 1</title></head><body><a href="/page2">P2</a></body></html>',
        ),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url in pages:
            status, html = pages[url]
            return httpx.Response(status, text=html, headers={"content-type": "text/html"})
        return httpx.Response(404, text="missing", headers={"content-type": "text/html"})

    previous_transport = crawl_manager.default_transport
    previous_storage = crawl_manager.storage
    crawl_manager.default_transport = httpx.MockTransport(handler)
    crawl_manager.storage = None
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            start_resp = await client.post(
                "/api/crawl",
                json={"url": "https://demo.local/", "max_depth": 1, "respect_robots": False},
            )
            assert start_resp.status_code == 200
            job_id = start_resp.json()["job_id"]

            events: list[tuple[str, dict]] = []
            async with client.stream("GET", f"/api/crawl/{job_id}/stream") as stream_resp:
                assert stream_resp.status_code == 200
                current_event = "message"
                async for line in stream_resp.aiter_lines():
                    if line.startswith("event: "):
                        current_event = line[len("event: ") :]
                    elif line.startswith("data: "):
                        events.append((current_event, json.loads(line[len("data: ") :])))

            event_types = [ev[0] for ev in events]
            assert "snapshot" in event_types
            assert "done" in event_types

            snap_resp = await client.get(f"/api/crawl/{job_id}")
            assert snap_resp.status_code == 200
            data = snap_resp.json()
            assert data["summary"]["status"] == "completed"
            node_ids = {n["id"] for n in data["nodes"]}
            assert "https://demo.local/" in node_ids
            assert "https://demo.local/page1" in node_ids
            assert "https://demo.local/page2" not in node_ids
    finally:
        crawl_manager.default_transport = previous_transport
        crawl_manager.storage = previous_storage


@pytest.mark.asyncio
async def test_auto_save_list_load_download_and_delete(tmp_path: Path) -> None:
    db_file = tmp_path / "test_webgraph.db"
    test_storage = CrawlStorage(db_file)

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == "https://saved.local/":
            return httpx.Response(
                200,
                text='<html><head><title>Saved Root</title></head><body><a href="https://peer.local/">Peer</a></body></html>',
                headers={"content-type": "text/html"},
            )
        return httpx.Response(200, text="<html><title>Peer</title></html>", headers={"content-type": "text/html"})

    prev_transport = crawl_manager.default_transport
    prev_storage = crawl_manager.storage
    prev_main_storage = main_module.crawl_storage
    crawl_manager.default_transport = httpx.MockTransport(handler)
    crawl_manager.storage = test_storage
    main_module.crawl_storage = test_storage

    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            start_resp = await client.post(
                "/api/crawl",
                json={
                    "url": "https://saved.local/",
                    "graph_mode": "domains",
                    "max_depth": 1,
                    "respect_robots": False,
                },
            )
            assert start_resp.status_code == 200
            job_id = start_resp.json()["job_id"]

            # Drain SSE stream until done
            async with client.stream("GET", f"/api/crawl/{job_id}/stream") as stream_resp:
                async for _ in stream_resp.aiter_lines():
                    pass

            list_resp = await client.get("/api/saved")
            assert list_resp.status_code == 200
            items = list_resp.json()
            assert len(items) == 1
            assert items[0]["job_id"] == job_id
            assert items[0]["compressed_bytes"] > 0

            load_resp = await client.get(f"/api/saved/{job_id}")
            assert load_resp.status_code == 200
            loaded = load_resp.json()
            assert loaded["summary"]["job_id"] == job_id
            assert len(loaded["nodes"]) == 2

            gz_resp = await client.get(f"/api/saved/{job_id}/download?fmt=gz")
            assert gz_resp.status_code == 200
            decompressed = json.loads(gzip.decompress(gz_resp.content).decode("utf-8"))
            assert decompressed["summary"]["job_id"] == job_id

            del_resp = await client.delete(f"/api/saved/{job_id}")
            assert del_resp.status_code == 200
            assert del_resp.json() == {"deleted": True}

            after_list = await client.get("/api/saved")
            assert after_list.json() == []
    finally:
        crawl_manager.default_transport = prev_transport
        crawl_manager.storage = prev_storage
        main_module.crawl_storage = prev_main_storage
        test_storage.close()

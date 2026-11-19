from __future__ import annotations

import asyncio
import json
from typing import AsyncGenerator, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

from app.crawler import CrawlManager
from app.models import CrawlGraphResponse, CrawlJobSummary, CrawlRequest, SavedCrawlMeta
from app.storage import CrawlStorage

app = FastAPI(title="Web-Graph Crawler API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

crawl_storage = CrawlStorage()
crawl_manager = CrawlManager(storage=crawl_storage)


@app.get("/api/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/crawl", response_model=CrawlJobSummary)
async def start_crawl(request: CrawlRequest) -> CrawlJobSummary:
    try:
        job = crawl_manager.create_job(request)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return job.summary()


@app.get("/api/crawl/{job_id}", response_model=CrawlGraphResponse)
async def get_crawl_graph(job_id: str) -> CrawlGraphResponse:
    job = crawl_manager.get_job(job_id)
    if job is not None:
        return job.snapshot()
    saved = crawl_storage.get_crawl(job_id)
    if saved is not None:
        return saved
    raise HTTPException(status_code=404, detail="Crawl job not found")


@app.post("/api/crawl/{job_id}/stop", response_model=CrawlJobSummary)
async def stop_crawl(job_id: str) -> CrawlJobSummary:
    job = crawl_manager.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Crawl job not found")
    job.stop()
    return job.summary()


@app.get("/api/crawl/{job_id}/stream")
async def stream_crawl(job_id: str) -> StreamingResponse:
    job = crawl_manager.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Crawl job not found")

    queue = job.subscribe()

    async def event_generator() -> AsyncGenerator[str, None]:
        try:
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue

                if event is None:
                    break

                event_type = event["type"]
                payload = json.dumps(event["data"], ensure_ascii=False)
                yield f"event: {event_type}\ndata: {payload}\n\n"
        finally:
            job.unsubscribe(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/saved", response_model=list[SavedCrawlMeta])
async def list_saved_crawls(limit: int = Query(default=50, ge=1, le=200)) -> list[SavedCrawlMeta]:
    return crawl_storage.list_crawls(limit=limit)


@app.get("/api/saved/{job_id}", response_model=CrawlGraphResponse)
async def load_saved_crawl(job_id: str) -> CrawlGraphResponse:
    saved = crawl_storage.get_crawl(job_id)
    if saved is None:
        raise HTTPException(status_code=404, detail="Saved crawl not found")
    return saved


@app.get("/api/saved/{job_id}/download")
async def download_saved_crawl(
    job_id: str,
    fmt: Literal["gz", "json"] = Query(default="gz"),
) -> Response:
    if fmt == "gz":
        data = crawl_storage.get_gzip_bytes(job_id)
        if data is None:
            raise HTTPException(status_code=404, detail="Saved crawl not found")
        return Response(
            content=data,
            media_type="application/gzip",
            headers={"Content-Disposition": f'attachment; filename="webgraph-{job_id}.json.gz"'},
        )

    raw = crawl_storage.get_raw_json_bytes(job_id)
    if raw is None:
        raise HTTPException(status_code=404, detail="Saved crawl not found")
    return Response(
        content=raw,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="webgraph-{job_id}.json"'},
    )


@app.delete("/api/saved/{job_id}")
async def delete_saved_crawl(job_id: str) -> dict[str, bool]:
    deleted = crawl_storage.delete_crawl(job_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Saved crawl not found")
    return {"deleted": True}

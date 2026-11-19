from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

if TYPE_CHECKING:
    from app.storage import CrawlStorage

import httpx

from app.models import (
    CrawlGraphResponse,
    CrawlJobSummary,
    CrawlRequest,
    EdgeSample,
    GraphEdge,
    GraphNode,
    JobStatus,
)
from app.url_utils import (
    canonical_website_domain,
    default_label_for_url,
    extract_domain,
    extract_html_metadata,
    is_ignored_domain,
    is_in_scope,
    is_likely_static_asset,
    normalize_seed_url,
)

logger = logging.getLogger(__name__)

DEFAULT_USER_AGENT = "WebGraphCrawler/1.0 (+https://localhost/web-graph)"


@dataclass
class FetchResult:
    url: str
    final_url: str
    status_code: int | None = None
    content_type: str | None = None
    title: str | None = None
    links: list[str] = field(default_factory=list)
    error: str | None = None


class CrawlJob:
    """Manages state, BFS execution, and real-time SSE subscribers for one crawl."""

    def __init__(
        self,
        job_id: str,
        request: CrawlRequest,
        transport: httpx.AsyncBaseTransport | None = None,
        on_complete: Callable[[CrawlJob], None] | None = None,
    ) -> None:
        self.job_id = job_id
        self.request = request
        self.on_complete = on_complete
        self.seed_urls: list[str] = [normalize_seed_url(request.url)]
        for extra in request.extra_urls:
            cleaned = extra.strip()
            if cleaned:
                norm = normalize_seed_url(cleaned)
                if norm not in self.seed_urls:
                    self.seed_urls.append(norm)

        self.seed_url = self.seed_urls[0]
        self.seed_domain = extract_domain(self.seed_url)
        self.transport = transport

        self.status: JobStatus = "running"
        self.error: str | None = None
        self.pages_crawled: int = 0

        self.nodes: dict[str, GraphNode] = {}
        self.edges: dict[tuple[str, str], GraphEdge] = {}
        self.visited: set[str] = set()

        self._robots_cache: dict[str, RobotFileParser | None] = {}
        self._robots_lock = asyncio.Lock()
        self._stop_event = asyncio.Event()
        self._subscribers: list[asyncio.Queue[dict | None]] = []
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self.run())

    def stop(self) -> None:
        self._stop_event.set()
        if self.status == "running":
            self.status = "stopped"

    def summary(self) -> CrawlJobSummary:
        return CrawlJobSummary(
            job_id=self.job_id,
            status=self.status,
            graph_mode=self.request.graph_mode,
            seed_url=self.seed_url,
            max_depth=self.request.max_depth,
            max_pages=self.request.max_pages,
            pages_crawled=self.pages_crawled,
            nodes_count=len(self.nodes),
            edges_count=len(self.edges),
            error=self.error,
        )

    def snapshot(self) -> CrawlGraphResponse:
        return CrawlGraphResponse(
            summary=self.summary(),
            nodes=list(self.nodes.values()),
            links=list(self.edges.values()),
        )

    def subscribe(self) -> asyncio.Queue[dict | None]:
        queue: asyncio.Queue[dict | None] = asyncio.Queue()
        queue.put_nowait(
            {
                "type": "snapshot",
                "data": self.snapshot().model_dump(),
            }
        )
        if self.status != "running":
            queue.put_nowait(None)
        else:
            self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[dict | None]) -> None:
        if queue in self._subscribers:
            self._subscribers.remove(queue)

    def _broadcast(self, event_type: str, data: dict) -> None:
        payload = {"type": event_type, "data": data}
        for queue in list(self._subscribers):
            queue.put_nowait(payload)

    def _close_subscribers(self) -> None:
        for queue in list(self._subscribers):
            queue.put_nowait(None)
        self._subscribers.clear()

    async def _is_allowed_by_robots(self, client: httpx.AsyncClient, url: str) -> bool:
        if not self.request.respect_robots:
            return True

        parsed = urlparse(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"

        async with self._robots_lock:
            if origin not in self._robots_cache:
                robots_url = f"{origin}/robots.txt"
                rp: RobotFileParser | None = None
                try:
                    resp = await client.get(
                        robots_url,
                        timeout=min(4.0, self.request.timeout_seconds),
                    )
                    if resp.status_code == 200 and "text" in resp.headers.get(
                        "content-type", "text/plain"
                    ):
                        rp = RobotFileParser()
                        rp.set_url(robots_url)
                        rp.parse(resp.text.splitlines())
                except Exception:
                    rp = None
                self._robots_cache[origin] = rp

            cached = self._robots_cache[origin]

        if cached is None:
            return True
        return cached.can_fetch(DEFAULT_USER_AGENT, url)

    async def _fetch_page(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
        url: str,
    ) -> FetchResult:
        if self._stop_event.is_set():
            return FetchResult(url=url, final_url=url, error="Stopped")

        async with semaphore:
            if self._stop_event.is_set():
                return FetchResult(url=url, final_url=url, error="Stopped")

            try:
                allowed = await self._is_allowed_by_robots(client, url)
                if not allowed:
                    return FetchResult(url=url, final_url=url, error="Blocked by robots.txt")

                response = await client.get(url)
                final_url = str(response.url)
                content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()

                if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                    return FetchResult(
                        url=url,
                        final_url=final_url,
                        status_code=response.status_code,
                        content_type=content_type or "unknown",
                    )

                title, links = extract_html_metadata(response.text, final_url)
                return FetchResult(
                    url=url,
                    final_url=final_url,
                    status_code=response.status_code,
                    content_type=content_type,
                    title=title,
                    links=links,
                )
            except httpx.TimeoutException:
                return FetchResult(url=url, final_url=url, error="Request timeout")
            except httpx.HTTPError as exc:
                return FetchResult(url=url, final_url=url, error=str(exc) or "HTTP error")
            except Exception as exc:
                logger.exception("Unexpected error fetching %s", url)
                return FetchResult(url=url, final_url=url, error=str(exc))

    def _ensure_node(
        self,
        node_id: str,
        url: str,
        label: str,
        domain: str,
        depth: int,
        is_external: bool,
    ) -> GraphNode:
        existing = self.nodes.get(node_id)
        if existing is not None:
            return existing

        node = GraphNode(
            id=node_id,
            url=url,
            label=label,
            domain=domain,
            depth=depth,
            is_external=is_external,
        )
        self.nodes[node_id] = node
        self._broadcast("node", node.model_dump())
        return node

    def _add_edge(
        self,
        source: str,
        target: str,
        from_url: str | None = None,
        to_url: str | None = None,
    ) -> None:
        if source == target:
            return

        key = (source, target)
        existing = self.edges.get(key)
        if existing is not None:
            existing.weight += 1
            if from_url and to_url and len(existing.samples) < 12:
                sample = EdgeSample(from_url=from_url, to_url=to_url)
                if sample not in existing.samples:
                    existing.samples.append(sample)
            self._broadcast("edge", existing.model_dump())
            return

        samples: list[EdgeSample] = []
        if from_url and to_url:
            samples.append(EdgeSample(from_url=from_url, to_url=to_url))

        edge = GraphEdge(source=source, target=target, weight=1, samples=samples)
        self.edges[key] = edge
        if source in self.nodes:
            self.nodes[source].out_degree += 1
        if target in self.nodes:
            self.nodes[target].in_degree += 1
        self._broadcast("edge", edge.model_dump())

    async def _run_pages_mode(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
    ) -> None:
        current_level: list[str] = []
        for url in self.seed_urls:
            self._ensure_node(
                node_id=url,
                url=url,
                label=default_label_for_url(url),
                domain=extract_domain(url),
                depth=0,
                is_external=False,
            )
            self.visited.add(url)
            current_level.append(url)

        for depth in range(self.request.max_depth + 1):
            if self._stop_event.is_set() or not current_level:
                break
            if self.pages_crawled >= self.request.max_pages:
                break

            remaining_budget = self.request.max_pages - self.pages_crawled
            batch = current_level[:remaining_budget]
            next_level: list[str] = []

            results = await asyncio.gather(
                *[self._fetch_page(client, semaphore, url) for url in batch]
            )

            for result in results:
                if self._stop_event.is_set():
                    break

                self.pages_crawled += 1
                node = self.nodes[result.url]
                node.crawled = True
                node.pages_sampled += 1
                node.status_code = result.status_code
                node.content_type = result.content_type
                node.error = result.error
                if result.title:
                    node.label = result.title

                if depth == 0 and result.url == self.seed_url and result.final_url:
                    redirected_domain = extract_domain(result.final_url)
                    if redirected_domain:
                        self.seed_domain = redirected_domain
                        node.domain = redirected_domain
                        self.visited.add(result.final_url)

                self._broadcast("node", node.model_dump())

                if depth < self.request.max_depth and not result.error:
                    for target_url in result.links:
                        in_scope = is_in_scope(
                            target_url,
                            self.seed_domain,
                            self.request.scope,
                        )
                        is_external = not in_scope
                        if is_external and not self.request.include_external_leaves:
                            continue

                        self._ensure_node(
                            node_id=target_url,
                            url=target_url,
                            label=default_label_for_url(target_url),
                            domain=extract_domain(target_url),
                            depth=depth + 1,
                            is_external=is_external,
                        )
                        self._add_edge(result.url, target_url)

                        if (
                            in_scope
                            and target_url not in self.visited
                            and not is_likely_static_asset(target_url)
                        ):
                            self.visited.add(target_url)
                            next_level.append(target_url)

            self._broadcast("progress", self.summary().model_dump())
            current_level = next_level

    async def _run_domains_mode(
        self,
        client: httpx.AsyncClient,
        semaphore: asyncio.Semaphore,
    ) -> None:
        custom_ignored = {d.strip().lower() for d in self.request.ignored_domains if d.strip()}
        seed_domains: set[str] = set()
        visited_domains: set[str] = set()
        domain_queues: dict[str, list[str]] = {}

        for url in self.seed_urls:
            dom = canonical_website_domain(url)
            if not dom:
                continue
            seed_domains.add(dom)
            visited_domains.add(dom)
            self._ensure_node(
                node_id=dom,
                url=url,
                label=dom,
                domain=dom,
                depth=0,
                is_external=False,
            )
            domain_queues.setdefault(dom, [])
            if url not in domain_queues[dom]:
                domain_queues[dom].append(url)
                self.visited.add(url)

        current_domains = list(domain_queues.keys())

        for depth in range(self.request.max_depth + 1):
            if self._stop_event.is_set() or not current_domains:
                break
            if self.pages_crawled >= self.request.max_pages:
                break

            next_domains: list[str] = []
            # At leaf depth == max_depth, sample at most 1 page per website for title/status
            per_domain_limit = 1 if depth == self.request.max_depth else self.request.max_pages_per_domain
            sampled_per_domain: dict[str, int] = {dom: 0 for dom in current_domains}

            while not self._stop_event.is_set() and self.pages_crawled < self.request.max_pages:
                batch: list[tuple[str, str]] = []
                remaining_budget = self.request.max_pages - self.pages_crawled

                for dom in current_domains:
                    if len(batch) >= remaining_budget:
                        break
                    already_sampled = sampled_per_domain.get(dom, 0)
                    if already_sampled >= per_domain_limit:
                        continue
                    q = domain_queues.get(dom, [])
                    while q and already_sampled < per_domain_limit and len(batch) < remaining_budget:
                        candidate_url = q.pop(0)
                        batch.append((dom, candidate_url))
                        already_sampled += 1
                    sampled_per_domain[dom] = already_sampled

                if not batch:
                    break

                results = await asyncio.gather(
                    *[self._fetch_page(client, semaphore, url) for _, url in batch]
                )

                for (dom, _requested_url), result in zip(batch, results):
                    if self._stop_event.is_set():
                        break

                    self.pages_crawled += 1
                    node = self.nodes[dom]
                    node.crawled = True
                    node.pages_sampled += 1

                    # Prefer status/title from the primary/first sampled page unless earlier failed
                    if node.status_code is None or (node.error and not result.error):
                        node.status_code = result.status_code
                        node.content_type = result.content_type
                        node.error = result.error
                    if result.title and (node.label == dom or node.pages_sampled == 1):
                        node.label = f"{dom} — {result.title}"

                    self._broadcast("node", node.model_dump())

                    if result.error:
                        continue

                    for target_url in result.links:
                        if is_likely_static_asset(target_url):
                            continue

                        target_dom = canonical_website_domain(target_url)
                        if not target_dom:
                            continue

                        if target_dom == dom:
                            # Same website: keep in internal queue for extra outbound harvesting
                            if (
                                depth < self.request.max_depth
                                and sampled_per_domain.get(dom, 0) + len(domain_queues.get(dom, []))
                                < per_domain_limit
                                and target_url not in self.visited
                            ):
                                self.visited.add(target_url)
                                domain_queues.setdefault(dom, []).append(target_url)
                            continue

                        if is_ignored_domain(
                            target_dom,
                            self.request.exclude_common_platforms,
                            custom_ignored,
                        ):
                            continue

                        if depth < self.request.max_depth:
                            is_new_domain = target_dom not in self.nodes
                            self._ensure_node(
                                node_id=target_dom,
                                url=target_url,
                                label=target_dom,
                                domain=target_dom,
                                depth=depth + 1,
                                is_external=target_dom not in seed_domains,
                            )
                            self._add_edge(
                                dom,
                                target_dom,
                                from_url=result.final_url or result.url,
                                to_url=target_url,
                            )

                            if is_new_domain or target_dom not in visited_domains:
                                visited_domains.add(target_dom)
                                next_domains.append(target_dom)

                            if (
                                target_dom in next_domains
                                and len(domain_queues.get(target_dom, []))
                                < self.request.max_pages_per_domain
                                and target_url not in self.visited
                            ):
                                self.visited.add(target_url)
                                domain_queues.setdefault(target_dom, []).append(target_url)
                        elif self.request.max_depth > 0 and target_dom in self.nodes:
                            # At max_depth > 0, still record links back to already-discovered websites
                            self._add_edge(
                                dom,
                                target_dom,
                                from_url=result.final_url or result.url,
                                to_url=target_url,
                            )

            self._broadcast("progress", self.summary().model_dump())
            current_domains = next_domains

    async def run(self) -> None:
        try:
            semaphore = asyncio.Semaphore(self.request.concurrency)

            client_kwargs: dict = {
                "follow_redirects": True,
                "timeout": httpx.Timeout(self.request.timeout_seconds),
                "headers": {"User-Agent": DEFAULT_USER_AGENT},
            }
            if self.transport is not None:
                client_kwargs["transport"] = self.transport

            async with httpx.AsyncClient(**client_kwargs) as client:
                if self.request.graph_mode == "domains":
                    await self._run_domains_mode(client, semaphore)
                else:
                    await self._run_pages_mode(client, semaphore)

            if self._stop_event.is_set():
                self.status = "stopped"
            else:
                self.status = "completed"
        except Exception as exc:
            logger.exception("Crawl job %s failed", self.job_id)
            self.status = "failed"
            self.error = str(exc)
        finally:
            if self.on_complete is not None and len(self.nodes) > 0:
                try:
                    self.on_complete(self)
                except Exception:
                    logger.exception("Failed to persist crawl job %s", self.job_id)
            self._broadcast("done", self.summary().model_dump())
            self._close_subscribers()


class CrawlManager:
    """In-memory registry for active and completed crawl jobs."""

    def __init__(
        self,
        default_transport: httpx.AsyncBaseTransport | None = None,
        storage: CrawlStorage | None = None,
    ) -> None:
        self.jobs: dict[str, CrawlJob] = {}
        self.default_transport = default_transport
        self.storage = storage

    def _persist_job(self, job: CrawlJob) -> None:
        if self.storage is not None:
            self.storage.save_crawl(job.snapshot())

    def create_job(
        self,
        request: CrawlRequest,
        transport: httpx.AsyncBaseTransport | None = None,
        auto_start: bool = True,
    ) -> CrawlJob:
        job_id = uuid.uuid4().hex[:12]
        job = CrawlJob(
            job_id=job_id,
            request=request,
            transport=transport or self.default_transport,
            on_complete=self._persist_job if self.storage is not None else None,
        )
        self.jobs[job_id] = job
        if auto_start:
            job.start()
        return job

    def get_job(self, job_id: str) -> CrawlJob | None:
        return self.jobs.get(job_id)

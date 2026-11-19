from __future__ import annotations

from typing import Literal
from pydantic import BaseModel, Field, field_validator

CrawlScope = Literal["internal", "subdomains", "all"]
GraphMode = Literal["pages", "domains"]
JobStatus = Literal["running", "completed", "stopped", "failed"]


class CrawlRequest(BaseModel):
    """Configuration payload to start a recursive web crawl job."""

    url: str = Field(..., description="Primary seed URL to start crawling from")
    extra_urls: list[str] = Field(
        default_factory=list,
        description="Optional additional seed URLs for multi-site network comparison",
    )
    graph_mode: GraphMode = Field(
        default="pages",
        description="pages = URL-level graph, domains = website-to-website (domain-aggregated) graph",
    )
    max_depth: int = Field(default=2, ge=0, description="Maximum BFS depth (unlimited >= 0)")
    max_pages: int = Field(default=100, ge=1, le=10000, description="Maximum pages to fetch")
    max_pages_per_domain: int = Field(
        default=2,
        ge=1,
        le=20,
        description="In domains mode, max pages sampled per website to harvest outbound links",
    )
    scope: CrawlScope = Field(
        default="internal",
        description="internal = same host, subdomains = same root host, all = cross-domain",
    )
    include_external_leaves: bool = Field(
        default=True,
        description="In pages mode, include out-of-scope links as leaf nodes without crawling further",
    )
    exclude_common_platforms: bool = Field(
        default=True,
        description="In domains mode, filter out common social/analytics/font utility domains",
    )
    ignored_domains: list[str] = Field(
        default_factory=list,
        description="Additional domain names to exclude in domains mode",
    )
    concurrency: int = Field(default=5, ge=1, le=20, description="Concurrent HTTP fetches")
    respect_robots: bool = Field(default=True, description="Respect robots.txt rules when available")
    timeout_seconds: float = Field(default=10.0, ge=1.0, le=60.0, description="Per-request timeout")

    @field_validator("url")
    @classmethod
    def validate_url_non_empty(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("URL cannot be empty")
        return cleaned


class GraphNode(BaseModel):
    """Represents a webpage or website node in the crawled web graph."""

    id: str
    url: str
    label: str
    domain: str
    depth: int
    status_code: int | None = None
    content_type: str | None = None
    error: str | None = None
    is_external: bool = False
    crawled: bool = False
    pages_sampled: int = 0
    in_degree: int = 0
    out_degree: int = 0


class EdgeSample(BaseModel):
    """Sample source->target page URL pair backing a website-level edge."""

    from_url: str
    to_url: str


class GraphEdge(BaseModel):
    """Represents a directed hyperlink (or aggregated domain link) from source to target."""

    source: str
    target: str
    weight: int = 1
    samples: list[EdgeSample] = Field(default_factory=list)


class CrawlJobSummary(BaseModel):
    """Snapshot summary of a crawl job."""

    job_id: str
    status: JobStatus
    graph_mode: GraphMode = "pages"
    seed_url: str
    max_depth: int
    max_pages: int
    pages_crawled: int
    nodes_count: int
    edges_count: int
    error: str | None = None


class CrawlGraphResponse(BaseModel):
    """Complete job summary plus graph nodes and edges."""

    summary: CrawlJobSummary
    nodes: list[GraphNode]
    links: list[GraphEdge]


class SavedCrawlMeta(BaseModel):
    """Lightweight metadata for a persisted crawl stored in SQLite."""

    job_id: str
    seed_url: str
    graph_mode: GraphMode
    status: JobStatus
    max_depth: int
    pages_crawled: int
    nodes_count: int
    edges_count: int
    compressed_bytes: int
    created_at: str

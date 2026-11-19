from __future__ import annotations

import httpx
import pytest

from app.crawler import CrawlJob
from app.models import CrawlRequest
from app.url_utils import extract_html_metadata, is_in_scope, normalize_seed_url, normalize_url


def test_normalize_seed_url_adds_https() -> None:
    assert normalize_seed_url("example.com") == "https://example.com/"
    assert normalize_seed_url("http://Example.COM:80/test/") == "http://example.com/test"


def test_normalize_url_filters_and_resolves() -> None:
    base = "https://example.com/docs/intro"
    assert normalize_url("#section", base) is None
    assert normalize_url("mailto:hi@example.com", base) is None
    assert normalize_url("javascript:void(0)", base) is None
    assert normalize_url("../about#team", base) == "https://example.com/about"
    assert normalize_url("/blog/", base) == "https://example.com/blog"


def test_extract_html_metadata_deduplicates_links() -> None:
    html = """
    <html>
      <head><title>  Home Page  </title></head>
      <body>
        <a href="/about">About</a>
        <a href="/about#footer">About Footer</a>
        <a href="https://external.org/ref">Ref</a>
        <a href="mailto:test@example.com">Email</a>
      </body>
    </html>
    """
    title, links = extract_html_metadata(html, "https://example.com/")
    assert title == "Home Page"
    assert links == ["https://example.com/about", "https://external.org/ref"]


def test_scope_rules() -> None:
    assert is_in_scope("https://example.com/a", "example.com", "internal") is True
    assert is_in_scope("https://sub.example.com/a", "example.com", "internal") is False
    assert is_in_scope("https://sub.example.com/a", "example.com", "subdomains") is True
    assert is_in_scope("https://other.org/a", "example.com", "subdomains") is False
    assert is_in_scope("https://other.org/a", "example.com", "all") is True


def _build_mock_transport() -> httpx.MockTransport:
    pages = {
        "https://site.test/": (
            200,
            "<html><head><title>Root</title></head><body>"
            '<a href="/level1">L1</a>'
            '<a href="https://ext.test/out">External</a>'
            "</body></html>",
        ),
        "https://site.test/level1": (
            200,
            "<html><head><title>Level 1</title></head><body>"
            '<a href="/level2">L2</a>'
            '<a href="/">Back Root</a>'
            "</body></html>",
        ),
        "https://site.test/level2": (
            200,
            "<html><head><title>Level 2</title></head><body>"
            '<a href="/level3">L3</a>'
            '<a href="/">Back Root</a>'
            "</body></html>",
        ),
        "https://site.test/level3": (
            200,
            "<html><head><title>Level 3</title></head><body><p>End</p></body></html>",
        ),
        "https://ext.test/out": (
            200,
            "<html><head><title>External</title></head><body><a href='https://ext.test/deep'>Deep</a></body></html>",
        ),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/robots.txt"):
            return httpx.Response(404, text="Not found")
        if url in pages:
            status, body = pages[url]
            return httpx.Response(status, text=body, headers={"content-type": "text/html"})
        return httpx.Response(404, text="Not found", headers={"content-type": "text/html"})

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_bfs_crawl_respects_max_depth_and_cycles() -> None:
    req = CrawlRequest(
        url="https://site.test/",
        max_depth=2,
        max_pages=50,
        scope="internal",
        include_external_leaves=True,
        respect_robots=False,
    )
    job = CrawlJob(job_id="test1", request=req, transport=_build_mock_transport())
    await job.run()

    assert job.status == "completed"
    # Depth 0: /, Depth 1: /level1 + ext.test/out (leaf), Depth 2: /level2
    # /level3 (depth 3) must NOT be included
    assert "https://site.test/" in job.nodes
    assert "https://site.test/level1" in job.nodes
    assert "https://site.test/level2" in job.nodes
    assert "https://ext.test/out" in job.nodes
    assert "https://site.test/level3" not in job.nodes

    assert job.nodes["https://site.test/"].depth == 0
    assert job.nodes["https://site.test/level1"].depth == 1
    assert job.nodes["https://site.test/level2"].depth == 2
    assert job.nodes["https://ext.test/out"].is_external is True
    assert job.nodes["https://ext.test/out"].crawled is False

    # Circular edge from /level1 -> / is preserved
    assert ("https://site.test/level1", "https://site.test/") in job.edges


@pytest.mark.asyncio
async def test_bfs_crawl_excludes_external_when_disabled() -> None:
    req = CrawlRequest(
        url="https://site.test/",
        max_depth=1,
        max_pages=50,
        scope="internal",
        include_external_leaves=False,
        respect_robots=False,
    )
    job = CrawlJob(job_id="test2", request=req, transport=_build_mock_transport())
    await job.run()

    assert "https://ext.test/out" not in job.nodes
    assert "https://site.test/level1" in job.nodes
    assert "https://site.test/level2" not in job.nodes


@pytest.mark.asyncio
async def test_bfs_crawl_respects_max_pages() -> None:
    req = CrawlRequest(
        url="https://site.test/",
        max_depth=3,
        max_pages=2,
        scope="internal",
        include_external_leaves=False,
        respect_robots=False,
    )
    job = CrawlJob(job_id="test3", request=req, transport=_build_mock_transport())
    await job.run()

    assert job.pages_crawled == 2
    assert job.nodes["https://site.test/"].crawled is True
    assert job.nodes["https://site.test/level1"].crawled is True
    assert job.nodes["https://site.test/level2"].crawled is False


def _build_cross_domain_transport() -> httpx.MockTransport:
    pages = {
        "https://alpha.test/": (
            200,
            "<html><head><title>Alpha Home</title></head><body>"
            '<a href="/partners">Partners</a>'
            '<a href="https://www.beta.test/one">Beta 1</a>'
            '<a href="https://beta.test/two">Beta 2</a>'
            '<a href="https://twitter.com/alpha">Twitter</a>'
            "</body></html>",
        ),
        "https://alpha.test/partners": (
            200,
            "<html><head><title>Alpha Partners</title></head><body>"
            '<a href="https://gamma.test/">Gamma</a>'
            "</body></html>",
        ),
        "https://www.beta.test/one": (
            200,
            "<html><head><title>Beta One</title></head><body>"
            '<a href="https://delta.test/">Delta</a>'
            '<a href="https://alpha.test/">Back to Alpha</a>'
            "</body></html>",
        ),
        "https://beta.test/two": (
            200,
            "<html><head><title>Beta Two</title></head><body>"
            '<a href="https://shared.test/ref">Shared</a>'
            "</body></html>",
        ),
        "https://gamma.test/": (
            200,
            "<html><head><title>Gamma</title></head><body>"
            '<a href="https://shared.test/g">Shared</a>'
            '<a href="https://epsilon.test/">Epsilon</a>'
            "</body></html>",
        ),
        "https://omega.test/": (
            200,
            "<html><head><title>Omega</title></head><body>"
            '<a href="https://shared.test/from-omega">Shared</a>'
            "</body></html>",
        ),
        "https://shared.test/ref": (
            200,
            "<html><head><title>Shared</title></head><body></body></html>",
        ),
        "https://delta.test/": (
            200,
            "<html><head><title>Delta</title></head><body></body></html>",
        ),
        "https://twitter.com/alpha": (
            200,
            "<html><head><title>Twitter</title></head><body></body></html>",
        ),
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url in pages:
            status, body = pages[url]
            return httpx.Response(status, text=body, headers={"content-type": "text/html"})
        return httpx.Response(404, text="Not found", headers={"content-type": "text/html"})

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_domains_mode_aggregates_weighted_edges_and_filters_noise() -> None:
    req = CrawlRequest(
        url="https://alpha.test/",
        graph_mode="domains",
        max_depth=1,
        max_pages=50,
        max_pages_per_domain=2,
        exclude_common_platforms=True,
        respect_robots=False,
    )
    job = CrawlJob(job_id="dom1", request=req, transport=_build_cross_domain_transport())
    await job.run()

    assert job.status == "completed"
    # Noise domain twitter.com must be excluded
    assert "twitter.com" not in job.nodes
    # Alpha (depth 0), Beta & Gamma (depth 1 via /partners because max_pages_per_domain=2)
    assert job.nodes["alpha.test"].depth == 0
    assert job.nodes["beta.test"].depth == 1
    assert job.nodes["gamma.test"].depth == 1
    # Depth 2 domains (delta.test, shared.test, epsilon.test) must NOT be created at max_depth=1
    assert "delta.test" not in job.nodes
    assert "epsilon.test" not in job.nodes

    # Weighted edge alpha.test -> beta.test has weight 2 (www.beta.test/one + beta.test/two)
    edge_ab = job.edges[("alpha.test", "beta.test")]
    assert edge_ab.weight == 2
    assert len(edge_ab.samples) == 2

    # Reciprocal backlink at max_depth=1: beta.test -> alpha.test is recorded
    assert ("beta.test", "alpha.test") in job.edges


@pytest.mark.asyncio
async def test_domains_mode_multi_seed_overlap_and_platforms_toggle() -> None:
    req = CrawlRequest(
        url="https://alpha.test/",
        extra_urls=["https://omega.test/"],
        graph_mode="domains",
        max_depth=2,
        max_pages=50,
        max_pages_per_domain=2,
        exclude_common_platforms=False,
        respect_robots=False,
    )
    job = CrawlJob(job_id="dom2", request=req, transport=_build_cross_domain_transport())
    await job.run()

    assert job.nodes["alpha.test"].depth == 0
    assert job.nodes["omega.test"].depth == 0
    assert "twitter.com" in job.nodes
    # Both omega.test (depth 0 -> 1) and gamma.test/beta.test (depth 1 -> 2) point to shared.test
    assert "shared.test" in job.nodes
    assert job.nodes["shared.test"].in_degree >= 2


def test_crawl_request_allows_unbounded_depth() -> None:
    req = CrawlRequest(url="https://example.com", max_depth=25)
    assert req.max_depth == 25


def test_normalize_url_ignores_malformed_port_and_ipv6() -> None:
    base = "https://childrenandarmedconflict.un.org/"
    assert (
        normalize_url(
            "https://example.org: Children Affected by Conflict Endured Violations",
            base,
        )
        is None
    )
    assert normalize_url("https://[invalid-ipv6/path", base) is None

    html = """
    <html>
      <head><title>UN Report</title></head>
      <body>
        <a href="https://bad.test: Some Headline Text">Broken Link</a>
        <a href="https://valid.test/report">Valid Link</a>
      </body>
    </html>
    """
    title, links = extract_html_metadata(html, base)
    assert title == "UN Report"
    assert links == ["https://valid.test/report"]


from __future__ import annotations

import posixpath
import re
from urllib.parse import urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup

from app.models import CrawlScope

ALLOWED_SCHEMES = {"http", "https"}
SKIP_PREFIXES = ("#", "mailto:", "tel:", "javascript:", "data:", "blob:", "sms:")

COMMON_PLATFORM_DOMAINS = {
    "facebook.com",
    "fb.com",
    "fb.me",
    "instagram.com",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "linkedin.com",
    "pinterest.com",
    "youtube.com",
    "youtu.be",
    "t.me",
    "wa.me",
    "whatsapp.com",
    "threads.net",
    "snapchat.com",
    "reddit.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "googletagmanager.com",
    "google-analytics.com",
    "doubleclick.net",
    "schema.org",
    "w3.org",
}

# Common non-HTML static asset extensions to skip fetching as webpages
STATIC_ASSET_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp",
    ".pdf", ".zip", ".tar", ".gz", ".rar", ".7z",
    ".mp3", ".mp4", ".wav", ".avi", ".mov", ".webm",
    ".css", ".js", ".mjs", ".json", ".xml", ".woff", ".woff2", ".ttf", ".eot",
}


def normalize_seed_url(raw_url: str) -> str:
    """Validate and normalize a user-provided seed URL."""
    cleaned = raw_url.strip()
    if not cleaned:
        raise ValueError("URL tidak boleh kosong.")

    if "://" not in cleaned:
        cleaned = f"https://{cleaned}"

    normalized = normalize_url(cleaned)
    if not normalized:
        raise ValueError(f"URL tidak valid: {raw_url}")
    return normalized


def normalize_url(raw_url: str, base_url: str | None = None) -> str | None:
    """Resolve relative URLs, strip fragments, and normalize scheme/host/path."""
    if not raw_url:
        return None

    candidate = raw_url.strip()
    if not candidate or candidate.lower().startswith(SKIP_PREFIXES):
        return None

    try:
        resolved = urljoin(base_url, candidate) if base_url else candidate
        parsed = urlparse(resolved)

        scheme = parsed.scheme.lower()
        if scheme not in ALLOWED_SCHEMES or not parsed.netloc:
            return None

        hostname = (parsed.hostname or "").lower()
        if not hostname:
            return None

        port = parsed.port
    except ValueError:
        return None

    if port is not None and not (1 <= port <= 65535):
        return None
    if (scheme == "http" and port == 80) or (scheme == "https" and port == 443):
        port = None

    netloc = f"{hostname}:{port}" if port else hostname

    raw_path = parsed.path or "/"
    normalized_path = posixpath.normpath(raw_path) if raw_path.startswith("/") else raw_path
    if raw_path.endswith("/") and normalized_path != "/":
        normalized_path = normalized_path.rstrip("/")
    if not normalized_path.startswith("/"):
        normalized_path = f"/{normalized_path}"

    # Remove fragment (#...) completely
    return urlunparse((scheme, netloc, normalized_path, "", parsed.query, ""))


def extract_domain(url: str) -> str:
    """Return lowercase hostname without port."""
    try:
        parsed = urlparse(url)
        return (parsed.hostname or "").lower()
    except ValueError:
        return ""


def canonical_website_domain(url: str) -> str:
    """Return canonical website domain (lowercase, stripping leading 'www.')."""
    host = extract_domain(url)
    if host.startswith("www.") and len(host) > 4:
        return host[4:]
    return host


def is_ignored_domain(
    domain: str,
    exclude_common_platforms: bool,
    custom_ignored: set[str],
) -> bool:
    """Check whether a domain or its parent domain is in the noise filter list."""
    if not domain:
        return True

    blocked: set[str] = set(custom_ignored)
    if exclude_common_platforms:
        blocked |= COMMON_PLATFORM_DOMAINS

    for pattern in blocked:
        clean = pattern.strip().lower().lstrip(".")
        if clean.startswith("www.") and len(clean) > 4:
            clean = clean[4:]
        if not clean:
            continue
        if domain == clean or domain.endswith(f".{clean}"):
            return True
    return False


def is_likely_static_asset(url: str) -> bool:
    """Check if URL path ends with a known non-HTML static asset extension."""
    path = urlparse(url).path.lower()
    _, ext = posixpath.splitext(path)
    return ext in STATIC_ASSET_EXTENSIONS


def is_in_scope(target_url: str, seed_domain: str, scope: CrawlScope) -> bool:
    """Determine if target_url is eligible for crawling under the selected scope."""
    if scope == "all":
        return True

    target_domain = extract_domain(target_url)
    if not target_domain or not seed_domain:
        return False

    if scope == "internal":
        return target_domain == seed_domain

    # scope == "subdomains"
    base_domain = seed_domain[4:] if seed_domain.startswith("www.") else seed_domain
    return target_domain == base_domain or target_domain.endswith(f".{base_domain}")


def default_label_for_url(url: str) -> str:
    """Generate a concise fallback label from a URL when HTML <title> is missing."""
    parsed = urlparse(url)
    path = parsed.path or "/"
    if path == "/" and not parsed.query:
        return parsed.netloc
    label = f"{path}{'?' + parsed.query if parsed.query else ''}"
    return label if len(label) <= 48 else f"{label[:45]}..."


def extract_html_metadata(html: str, page_url: str) -> tuple[str | None, list[str]]:
    """Parse HTML to extract cleaned <title> and deduplicated normalized <a href> links."""
    soup = BeautifulSoup(html, "lxml")

    base_tag = soup.find("base", href=True)
    effective_base = page_url
    if base_tag and isinstance(base_tag.get("href"), str):
        resolved_base = normalize_url(base_tag["href"], page_url)
        if resolved_base:
            effective_base = resolved_base

    title: str | None = None
    if soup.title and soup.title.string:
        collapsed = re.sub(r"\s+", " ", soup.title.string).strip()
        if collapsed:
            title = collapsed[:120]

    links: list[str] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = anchor.get("href")
        if not isinstance(href, str):
            continue
        normalized = normalize_url(href, effective_base)
        if not normalized or normalized == page_url or normalized in seen:
            continue
        seen.add(normalized)
        links.append(normalized)

    return title, links

import type {
  CrawlJobSummary,
  EdgeSample,
  GraphEdge,
  GraphMode,
  GraphNode,
} from '../types/graph';

interface CompactEdgeTuple {
  0: number;
  1: number;
  2?: number;
  3?: EdgeSample[];
}

export interface ParsedGraphPayload {
  nodes: GraphNode[];
  links: GraphEdge[];
  graphMode: GraphMode;
  summary: CrawlJobSummary | null;
}

function getEndpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

/**
 * Build a compact indexed v2 JSON payload (edges reference integer node indices
 * and D3 simulation coordinates are stripped for minimal file size).
 */
export function buildCompactGraphPayload(
  nodes: GraphNode[],
  links: GraphEdge[],
  graphMode: GraphMode,
  summary: CrawlJobSummary | null
) {
  const indexById = new Map<string, number>();
  const cleanNodes = nodes.map((n, idx) => {
    indexById.set(n.id, idx);
    return {
      id: n.id,
      url: n.url,
      label: n.label,
      domain: n.domain,
      depth: n.depth,
      status_code: n.status_code,
      content_type: n.content_type,
      error: n.error,
      is_external: n.is_external,
      crawled: n.crawled,
      pages_sampled: n.pages_sampled ?? 0,
      in_degree: n.in_degree,
      out_degree: n.out_degree,
    };
  });

  const compactEdges: Array<[number, number, number] | [number, number, number, EdgeSample[]]> = [];
  for (const edge of links) {
    const sIdx = indexById.get(getEndpointId(edge.source));
    const tIdx = indexById.get(getEndpointId(edge.target));
    if (sIdx === undefined || tIdx === undefined) continue;
    const w = edge.weight ?? 1;
    if (edge.samples && edge.samples.length > 0) {
      compactEdges.push([sIdx, tIdx, w, edge.samples]);
    } else {
      compactEdges.push([sIdx, tIdx, w]);
    }
  }

  return {
    version: 2,
    graph_mode: graphMode,
    summary,
    nodes: cleanNodes,
    edges: compactEdges,
  };
}

/**
 * Compress a string into a Gzip Blob using the browser's native CompressionStream.
 */
export async function gzipString(text: string): Promise<Blob | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function gunzipBuffer(buffer: ArrayBuffer): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser ini tidak mendukung dekompresi gzip secara langsung.');
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

function isGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Parse an uploaded .json or .json.gz graph file (supports v1 export,
 * backend CrawlGraphResponse, and v2 compact indexed format).
 */
export async function parseUploadedGraphFile(file: File): Promise<ParsedGraphPayload> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let rawText: string;
  if (file.name.toLowerCase().endsWith('.gz') || isGzipMagic(bytes)) {
    rawText = await gunzipBuffer(buffer);
  } else {
    rawText = new TextDecoder('utf-8').decode(bytes);
  }

  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  if (!parsed || !Array.isArray(parsed.nodes)) {
    throw new Error('Format file graph tidak valid: array "nodes" tidak ditemukan.');
  }

  const nodes: GraphNode[] = (parsed.nodes as Array<Partial<GraphNode>>).map((n) => ({
    id: String(n.id ?? ''),
    url: String(n.url ?? n.id ?? ''),
    label: String(n.label ?? n.domain ?? n.id ?? ''),
    domain: String(n.domain ?? ''),
    depth: Number(n.depth ?? 0),
    status_code: n.status_code ?? null,
    content_type: n.content_type ?? null,
    error: n.error ?? null,
    is_external: Boolean(n.is_external ?? false),
    crawled: Boolean(n.crawled ?? true),
    pages_sampled: Number(n.pages_sampled ?? 0),
    in_degree: Number(n.in_degree ?? 0),
    out_degree: Number(n.out_degree ?? 0),
  }));

  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const links: GraphEdge[] = [];

  // Format v2: compact indexed edges
  if (Array.isArray(parsed.edges)) {
    for (const tuple of parsed.edges as CompactEdgeTuple[]) {
      if (!Array.isArray(tuple) || tuple.length < 2) continue;
      const srcNode = nodes[tuple[0]];
      const dstNode = nodes[tuple[1]];
      if (!srcNode || !dstNode) continue;
      links.push({
        source: srcNode.id,
        target: dstNode.id,
        weight: Number(tuple[2] ?? 1),
        samples: Array.isArray(tuple[3]) ? tuple[3] : [],
      });
    }
  } else if (Array.isArray(parsed.links)) {
    // Format v1 or backend CrawlGraphResponse
    for (const rawEdge of parsed.links as Array<{
      source: string | { id: string };
      target: string | { id: string };
      weight?: number;
      samples?: EdgeSample[];
    }>) {
      const s = typeof rawEdge.source === 'string' ? rawEdge.source : rawEdge.source?.id;
      const t = typeof rawEdge.target === 'string' ? rawEdge.target : rawEdge.target?.id;
      if (!s || !t || !nodeIdSet.has(s) || !nodeIdSet.has(t)) continue;
      links.push({
        source: s,
        target: t,
        weight: Number(rawEdge.weight ?? 1),
        samples: Array.isArray(rawEdge.samples) ? rawEdge.samples : [],
      });
    }
  }

  // Recompute in/out degrees if missing
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const edge of links) {
    const s = getEndpointId(edge.source);
    const t = getEndpointId(edge.target);
    outDeg.set(s, (outDeg.get(s) ?? 0) + 1);
    inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
  }
  for (const node of nodes) {
    if (node.in_degree === 0 && (inDeg.get(node.id) ?? 0) > 0) {
      node.in_degree = inDeg.get(node.id) ?? 0;
    }
    if (node.out_degree === 0 && (outDeg.get(node.id) ?? 0) > 0) {
      node.out_degree = outDeg.get(node.id) ?? 0;
    }
  }

  const summary = (parsed.summary as CrawlJobSummary | null | undefined) ?? null;
  const graphMode: GraphMode =
    parsed.graph_mode === 'pages' || summary?.graph_mode === 'pages' ? 'pages' : 'domains';

  return { nodes, links, graphMode, summary };
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';
import {
  Crosshair,
  Download,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Maximize2,
  Pause,
  Play,
  Search,
  Upload,
} from 'lucide-react';
import type {
  CenterMode,
  ColorMode,
  CrawlJobSummary,
  GraphEdge,
  GraphMode,
  GraphNode,
  SizeMode,
} from '../types/graph';
import { buildCompactGraphPayload, gzipString } from '../utils/graphFile';

interface GraphCanvasProps {
  nodes: GraphNode[];
  links: GraphEdge[];
  graphMode: GraphMode;
  summary: CrawlJobSummary | null;
  maxDepthConfigured: number;
  pageRankScores: Map<string, number>;
  rankPositions: Map<string, number>;
  selectedNodeId: string | null;
  selectedEdge: GraphEdge | null;
  onSelectNode: (nodeId: string | null) => void;
  onSelectEdge: (edge: GraphEdge | null) => void;
  onUploadFile: (file: File) => void;
}

type FastGraphEdge = GraphEdge & {
  _srcId?: string;
  _dstId?: string;
  _isMutual?: boolean;
};

const DEPTH_PALETTE = [
  '#22d3ee', // depth 0: cyan
  '#818cf8', // depth 1: indigo
  '#c084fc', // depth 2: purple
  '#fbbf24', // depth 3: amber
  '#fb7185', // depth 4: rose
  '#34d399', // depth 5+: emerald
];

const MAX_CONCURRENT_FAVICONS = 8;
const DENSE_NODE_THRESHOLD = 350;
const DENSE_EDGE_ARROW_THRESHOLD = 600;

function hashColor(domain: string): string {
  let hash = 0;
  for (let i = 0; i < domain.length; i += 1) {
    hash = (hash * 31 + domain.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 72%, 62%)`;
}

function getTldColor(domain: string): string {
  const lower = domain.toLowerCase();
  if (lower.endsWith('.edu') || lower.includes('.ac.') || lower.includes('.edu.')) {
    return '#60a5fa';
  }
  if (lower.endsWith('.gov') || lower.includes('.go.') || lower.includes('.gov.')) {
    return '#fbbf24';
  }
  if (lower.endsWith('.org') || lower.includes('.or.') || lower.includes('.io')) {
    return '#c084fc';
  }
  if (lower.endsWith('.id')) {
    return '#fb7185';
  }
  return '#34d399';
}

function getEndpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

function getNodeColor(node: GraphNode, mode: ColorMode, graphMode: GraphMode): string {
  if (mode === 'depth') {
    if (graphMode === 'pages' && node.is_external) return '#94a3b8';
    return DEPTH_PALETTE[Math.min(node.depth, DEPTH_PALETTE.length - 1)];
  }
  if (mode === 'status') {
    if (node.error) return '#f43f5e';
    if (node.status_code === null) return '#64748b';
    if (node.status_code >= 200 && node.status_code < 300) return '#10b981';
    if (node.status_code >= 300 && node.status_code < 400) return '#f59e0b';
    return '#f43f5e';
  }
  if (mode === 'tld') {
    return getTldColor(node.domain || node.id);
  }
  return hashColor(node.domain || node.url);
}

/** Pre-clip a loaded favicon image into a 48x48 circular offscreen canvas once. */
function createCircularFaviconCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const size = 48;
  const offscreen = document.createElement('canvas');
  offscreen.width = size;
  offscreen.height = size;
  const ctx = offscreen.getContext('2d');
  if (ctx) {
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, 2 * Math.PI);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, 0, 0, size, size);
  }
  return offscreen;
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  nodes,
  links,
  graphMode,
  summary,
  maxDepthConfigured,
  pageRankScores,
  rankPositions,
  selectedNodeId,
  selectedEdge,
  onSelectNode,
  onSelectEdge,
  onUploadFile,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraphMethods<GraphNode, GraphEdge> | undefined>(undefined);
  const faviconCacheRef = useRef<Map<string, HTMLCanvasElement | 'loading' | 'error'>>(new Map());
  const activeFaviconLoadsRef = useRef(0);
  const centerTargetIdRef = useRef<string | null>(null);

  // Hover refs prevent React re-renders on every pointer move over dense graphs
  const hoveredNodeIdRef = useRef<string | null>(null);
  const focusNodeIdRef = useRef<string | null>(null);
  const neighborSetRef = useRef<Set<string>>(new Set());

  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [colorMode, setColorMode] = useState<ColorMode>('depth');
  const [sizeMode, setSizeMode] = useState<SizeMode>('pagerank');
  const [centerMode, setCenterMode] = useState<CenterMode>('seed');
  const [topLimit, setTopLimit] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [maxVisibleDepth, setMaxVisibleDepth] = useState<number | null>(null);
  const [showExternal, setShowExternal] = useState(true);
  const [showFavicons, setShowFavicons] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      setDimensions({ width: el.clientWidth, height: el.clientHeight });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!selectedNodeId || !fgRef.current) return;
    const node = nodes.find((n) => n.id === selectedNodeId);
    if (node && typeof node.x === 'number' && typeof node.y === 'number') {
      fgRef.current.centerAt(node.x, node.y, 400);
    }
  }, [selectedNodeId, nodes]);

  const filteredData = useMemo(() => {
    let allowedNodes = nodes.filter((node) => {
      if (graphMode === 'pages' && !showExternal && node.is_external) return false;
      if (maxVisibleDepth !== null && node.depth > maxVisibleDepth) return false;
      return true;
    });

    if (topLimit !== null && allowedNodes.length > topLimit) {
      allowedNodes = [...allowedNodes]
        .sort((a, b) => {
          const rA = rankPositions.get(a.id) ?? Number.MAX_SAFE_INTEGER;
          const rB = rankPositions.get(b.id) ?? Number.MAX_SAFE_INTEGER;
          return rA - rB;
        })
        .slice(0, topLimit);
    }

    const allowedSet = new Set(allowedNodes.map((n) => n.id));
    const allowedLinks: FastGraphEdge[] = [];
    const edgeKeySet = new Set<string>();

    for (const link of links) {
      const s = getEndpointId(link.source);
      const t = getEndpointId(link.target);
      if (!allowedSet.has(s) || !allowedSet.has(t)) continue;
      const fastEdge = link as FastGraphEdge;
      fastEdge._srcId = s;
      fastEdge._dstId = t;
      edgeKeySet.add(`${s}\0${t}`);
      allowedLinks.push(fastEdge);
    }

    for (const fastEdge of allowedLinks) {
      fastEdge._isMutual = edgeKeySet.has(`${fastEdge._dstId}\0${fastEdge._srcId}`);
    }

    return { nodes: allowedNodes, links: allowedLinks };
  }, [nodes, links, graphMode, showExternal, maxVisibleDepth, topLimit, rankPositions]);

  // Precompute adjacency map once per graph update for O(1) hover neighbor lookups
  const adjacencyMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of filteredData.links) {
      const s = edge._srcId ?? getEndpointId(edge.source);
      const t = edge._dstId ?? getEndpointId(edge.target);
      let sSet = map.get(s);
      if (!sSet) {
        sSet = new Set();
        map.set(s, sSet);
      }
      sSet.add(t);

      let tSet = map.get(t);
      if (!tSet) {
        tSet = new Set();
        map.set(t, tSet);
      }
      tSet.add(s);
    }
    return map;
  }, [filteredData.links]);

  const syncFocusRefs = useCallback(
    (hoveredId: string | null, selectedId: string | null) => {
      hoveredNodeIdRef.current = hoveredId;
      const focusId = hoveredId ?? selectedId;
      focusNodeIdRef.current = focusId;
      if (!focusId) {
        neighborSetRef.current = new Set();
        return;
      }
      const nextNeighbors = new Set<string>([focusId]);
      const adj = adjacencyMap.get(focusId);
      if (adj) {
        for (const peer of adj) nextNeighbors.add(peer);
      }
      neighborSetRef.current = nextNeighbors;
    },
    [adjacencyMap]
  );

  // Sync refs whenever selectedNodeId or adjacencyMap changes
  useEffect(() => {
    syncFocusRefs(hoveredNodeIdRef.current, selectedNodeId);
  }, [selectedNodeId, syncFocusRefs]);

  const maxObservedDepth = useMemo(() => {
    let maxD = 0;
    for (const node of nodes) {
      if (node.depth > maxD) maxD = node.depth;
    }
    return Math.max(maxD, Math.min(maxDepthConfigured, maxD));
  }, [nodes, maxDepthConfigured]);

  const rankBounds = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const node of filteredData.nodes) {
      const pr = pageRankScores.get(node.id) ?? 0;
      if (pr < min) min = pr;
      if (pr > max) max = pr;
    }
    if (min === Infinity) return { min: 0, max: 0 };
    return { min, max };
  }, [filteredData.nodes, pageRankScores]);

  const centerNodeId = useMemo(() => {
    if (filteredData.nodes.length === 0) return null;
    if (centerMode === 'seed') {
      const seed = filteredData.nodes.find((n) => n.depth === 0);
      return seed ? seed.id : filteredData.nodes[0].id;
    }
    let bestId = filteredData.nodes[0].id;
    let bestScore = -1;
    for (const node of filteredData.nodes) {
      const score = pageRankScores.get(node.id) ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestId = node.id;
      }
    }
    return bestId;
  }, [centerMode, filteredData.nodes, pageRankScores]);

  centerTargetIdRef.current = centerNodeId;

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || filteredData.nodes.length === 0) return;

    let simNodes: GraphNode[] = [];
    const centerForce = (alpha: number) => {
      const targetId = centerTargetIdRef.current;
      if (!targetId) return;
      for (const node of simNodes) {
        if (node.id === targetId) {
          const strength = alpha * 0.45;
          node.vx = (node.vx ?? 0) - (node.x ?? 0) * strength;
          node.vy = (node.vy ?? 0) - (node.y ?? 0) * strength;
          break;
        }
      }
    };
    centerForce.initialize = (initNodes: GraphNode[]) => {
      simNodes = initNodes;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fg.d3Force('centerTarget', centerForce as any);
  }, [filteredData.nodes.length]);

  const handleFocusCenter = useCallback(() => {
    const fg = fgRef.current;
    if (!fg || !centerNodeId) return;
    fg.d3ReheatSimulation();
    const target = filteredData.nodes.find((n) => n.id === centerNodeId);
    fg.centerAt(target?.x ?? 0, target?.y ?? 0, 500);
  }, [centerNodeId, filteredData.nodes]);

  useEffect(() => {
    if (!fgRef.current || filteredData.nodes.length === 0) return;
    fgRef.current.d3ReheatSimulation();
    const target = filteredData.nodes.find((n) => n.id === centerNodeId);
    fgRef.current.centerAt(target?.x ?? 0, target?.y ?? 0, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerMode]);

  const getNodeRadius = useCallback(
    (node: GraphNode): number => {
      if (sizeMode === 'uniform') {
        return 7;
      }
      if (sizeMode === 'pagerank') {
        const pr = pageRankScores.get(node.id) ?? 0;
        const span = rankBounds.max - rankBounds.min;
        if (span <= 1e-12) return 7;
        const norm = Math.max(0, Math.min(1, (pr - rankBounds.min) / span));
        return 4.5 + Math.pow(norm, 0.65) * 14.5;
      }
      return node.depth === 0
        ? 10
        : 5 + Math.min(11, Math.sqrt(Math.max(0, node.in_degree)) * 2.2);
    },
    [pageRankScores, rankBounds, sizeMode]
  );

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return new Set<string>();
    const matches = new Set<string>();
    for (const node of filteredData.nodes) {
      if (
        node.url.toLowerCase().includes(q) ||
        node.label.toLowerCase().includes(q) ||
        node.domain.toLowerCase().includes(q)
      ) {
        matches.add(node.id);
      }
    }
    return matches;
  }, [filteredData.nodes, searchQuery]);

  const getFaviconCanvas = useCallback(
    (domain: string, nodeId: string, denseGraph: boolean): HTMLCanvasElement | null => {
      if (!domain) return null;
      const cache = faviconCacheRef.current;
      const entry = cache.get(domain);
      if (entry === 'loading' || entry === 'error') return null;
      if (entry) return entry;

      // Throttle concurrent favicon fetches & limit on dense graphs to top-150 or hovered/selected
      if (activeFaviconLoadsRef.current >= MAX_CONCURRENT_FAVICONS) return null;
      if (denseGraph) {
        const rank = rankPositions.get(nodeId) ?? Number.MAX_SAFE_INTEGER;
        if (rank > 150 && nodeId !== hoveredNodeIdRef.current && nodeId !== selectedNodeId) {
          return null;
        }
      }

      cache.set(domain, 'loading');
      activeFaviconLoadsRef.current += 1;

      const img = new window.Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        activeFaviconLoadsRef.current = Math.max(0, activeFaviconLoadsRef.current - 1);
        cache.set(domain, createCircularFaviconCanvas(img));
      };
      img.onerror = () => {
        activeFaviconLoadsRef.current = Math.max(0, activeFaviconLoadsRef.current - 1);
        cache.set(domain, 'error');
      };
      img.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
      return null;
    },
    [rankPositions, selectedNodeId]
  );

  const handleTogglePhysics = useCallback(() => {
    if (!fgRef.current) return;
    if (isPaused) {
      fgRef.current.resumeAnimation();
    } else {
      fgRef.current.pauseAnimation();
    }
    setIsPaused((prev) => !prev);
  }, [isPaused]);

  const handleZoomToFit = useCallback(() => {
    fgRef.current?.zoomToFit(450, 48);
  }, []);

  const handleExportJSON = useCallback(() => {
    const payload = {
      graph_mode: graphMode,
      summary,
      nodes: filteredData.nodes.map(({ x: _x, y: _y, vx: _vx, vy: _vy, ...rest }) => ({
        ...rest,
        rank: rankPositions.get(rest.id) ?? null,
        pagerank: Number((pageRankScores.get(rest.id) ?? 0).toFixed(6)),
      })),
      links: filteredData.links.map((edge) => ({
        source: edge._srcId ?? getEndpointId(edge.source),
        target: edge._dstId ?? getEndpointId(edge.target),
        weight: edge.weight ?? 1,
        samples: edge.samples ?? [],
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `web-graph-${graphMode}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredData, graphMode, pageRankScores, rankPositions, summary]);

  const handleExportCompactGzip = useCallback(async () => {
    const compactPayload = buildCompactGraphPayload(
      filteredData.nodes,
      filteredData.links,
      graphMode,
      summary
    );
    const jsonText = JSON.stringify(compactPayload);
    const gzBlob = await gzipString(jsonText);

    const blob = gzBlob ?? new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = gzBlob ? `web-graph-${graphMode}.json.gz` : `web-graph-${graphMode}.compact.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredData, graphMode, summary]);

  const handleExportCSV = useCallback(() => {
    const header = 'source,target,weight\n';
    const rows = filteredData.links
      .map(
        (edge) =>
          `"${edge._srcId ?? getEndpointId(edge.source)}","${edge._dstId ?? getEndpointId(edge.target)}",${edge.weight ?? 1}`
      )
      .join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `web-graph-${graphMode}-edges.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredData, graphMode]);

  const handleExportPNG = useCallback(() => {
    const canvas = containerRef.current?.querySelector('canvas');
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `web-graph-${graphMode}.png`;
    a.click();
  }, [graphMode]);

  const denseNodes = filteredData.nodes.length > DENSE_NODE_THRESHOLD;
  const denseEdges = filteredData.links.length > DENSE_EDGE_ARROW_THRESHOLD;
  const hasSearchQuery = searchQuery.trim().length > 0;

  const drawNode = useCallback(
    (nodeObj: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = nodeObj.x ?? 0;
      const y = nodeObj.y ?? 0;
      const baseRadius = getNodeRadius(nodeObj);

      const hoveredId = hoveredNodeIdRef.current;
      const focusId = focusNodeIdRef.current;
      const isFocused = focusId !== null;
      const isMatch = searchMatches.has(nodeObj.id);
      const isNeighbor = neighborSetRef.current.has(nodeObj.id);
      const isCenter = nodeObj.id === centerNodeId;
      const isSelected = nodeObj.id === selectedNodeId;
      const isHovered = nodeObj.id === hoveredId;
      const isDimmed =
        (isFocused && !isNeighbor) || (hasSearchQuery && !isMatch && !isNeighbor);

      const color = getNodeColor(nodeObj, colorMode, graphMode);

      // Fast LOD path when zoomed far out or dense graph with distant nodes
      const useFastLod =
        !isHovered &&
        !isSelected &&
        !isCenter &&
        !isMatch &&
        (globalScale < 0.55 || (denseNodes && globalScale < 0.9));

      if (useFastLod) {
        ctx.globalAlpha = isDimmed ? 0.16 : 0.92;
        ctx.beginPath();
        ctx.arc(x, y, baseRadius, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
        return;
      }

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.2 : 1;

      if (isCenter || isSelected || isMatch) {
        ctx.beginPath();
        ctx.arc(x, y, baseRadius + 4 / Math.sqrt(globalScale), 0, 2 * Math.PI);
        ctx.fillStyle = isSelected
          ? 'rgba(34, 211, 238, 0.38)'
          : isMatch
            ? 'rgba(251, 191, 36, 0.4)'
            : 'rgba(56, 189, 248, 0.24)';
        ctx.fill();
      }

      const faviconCanvas =
        graphMode === 'domains' && showFavicons
          ? getFaviconCanvas(nodeObj.domain, nodeObj.id, denseNodes)
          : null;

      ctx.beginPath();
      ctx.arc(x, y, baseRadius, 0, 2 * Math.PI);
      ctx.fillStyle = faviconCanvas ? '#0f172a' : color;
      ctx.fill();

      // Single drawImage of pre-clipped circular canvas (zero ctx.clip overhead!)
      if (faviconCanvas) {
        const innerR = Math.max(2, baseRadius - 1.5);
        ctx.drawImage(faviconCanvas, x - innerR, y - innerR, innerR * 2, innerR * 2);
      }

      ctx.lineWidth =
        isCenter || isSelected
          ? Math.max(2.2 / globalScale, 2)
          : graphMode === 'domains'
            ? Math.max(1.8 / globalScale, 1.5)
            : 1 / globalScale;
      ctx.strokeStyle = isSelected
        ? '#ffffff'
        : isCenter
          ? '#38bdf8'
          : graphMode === 'domains'
            ? color
            : nodeObj.is_external
              ? '#f59e0b'
              : '#0f172a';
      ctx.stroke();

      // Show node name/URL & Rank ONLY when hovered
      if (isHovered) {
        const fontSize = Math.max(10, Math.min(13, 11.5 / Math.sqrt(globalScale)));
        ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
        const rawName = graphMode === 'domains' ? nodeObj.domain : nodeObj.label;
        const shortName = rawName.length > 36 ? `${rawName.slice(0, 33)}...` : rawName;
        const rank = rankPositions.get(nodeObj.id);
        const pr = pageRankScores.get(nodeObj.id) ?? 0;
        const text =
          rank !== undefined
            ? `${shortName} · Rank #${rank} (${(pr * 100).toFixed(2)}%)`
            : shortName;

        const textWidth = ctx.measureText(text).width;
        const padX = 5;
        const padY = 2.5;
        const boxY = y + baseRadius + 4;

        ctx.fillStyle = 'rgba(2, 6, 23, 0.9)';
        ctx.fillRect(
          x - textWidth / 2 - padX,
          boxY - padY,
          textWidth + padX * 2,
          fontSize + padY * 2
        );

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#67e8f9';
        ctx.fillText(text, x, boxY);
      }

      ctx.restore();
    },
    [
      centerNodeId,
      colorMode,
      denseNodes,
      getFaviconCanvas,
      getNodeRadius,
      graphMode,
      hasSearchQuery,
      pageRankScores,
      rankPositions,
      searchMatches,
      selectedNodeId,
      showFavicons,
    ]
  );

  const selectedEdgeKey = selectedEdge
    ? `${getEndpointId(selectedEdge.source)}\0${getEndpointId(selectedEdge.target)}`
    : null;

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setIsDraggingFile(true);
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDraggingFile(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDraggingFile(false);
      const file = e.dataTransfer.files?.[0];
      if (file) onUploadFile(file);
    },
    [onUploadFile]
  );

  return (
    <main
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative flex-1 overflow-hidden bg-slate-950"
    >
      {isDraggingFile && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-cyan-400 bg-cyan-500/10 px-8 py-6 text-center">
            <Upload className="h-8 w-8 text-cyan-300" />
            <div className="text-sm font-semibold text-cyan-200">
              Lepaskan file .json atau .json.gz untuk visualisasi instan
            </div>
          </div>
        </div>
      )}

      <div
        className="pointer-events-none absolute inset-0 opacity-25"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(148, 163, 184, 0.25) 1px, transparent 0)',
          backgroundSize: '28px 28px',
        }}
      />

      {/* Top Floating Toolbar */}
      <div className="pointer-events-none absolute top-3 right-3 left-3 z-10 flex flex-wrap items-center justify-between gap-2">
        <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-slate-800/90 bg-slate-900/90 px-3 py-2 shadow-xl backdrop-blur-md">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              placeholder={graphMode === 'domains' ? 'Cari domain / website...' : 'Cari URL / title...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-36 rounded-lg border border-slate-700/80 bg-slate-950/80 py-1 pr-2.5 pl-8 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-500"
            />
          </div>

          <div className="h-4 w-px bg-slate-800" />

          {/* Depth Filter */}
          <div className="flex items-center gap-1 text-[11px]">
            <span className="mr-0.5 text-slate-400">Depth:</span>
            {maxObservedDepth <= 6 ? (
              <>
                <button
                  type="button"
                  onClick={() => setMaxVisibleDepth(null)}
                  className={`rounded-md px-2 py-1 transition ${
                    maxVisibleDepth === null
                      ? 'bg-cyan-500/20 font-medium text-cyan-300'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  Semua
                </button>
                {Array.from({ length: maxObservedDepth + 1 }, (_, d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setMaxVisibleDepth(d)}
                    className={`rounded-md px-2 py-1 font-mono transition ${
                      maxVisibleDepth === d
                        ? 'bg-cyan-500/20 font-medium text-cyan-300'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    ≤{d}
                  </button>
                ))}
              </>
            ) : (
              <select
                value={maxVisibleDepth === null ? 'all' : String(maxVisibleDepth)}
                onChange={(e) =>
                  setMaxVisibleDepth(e.target.value === 'all' ? null : Number(e.target.value))
                }
                className="rounded-md border border-slate-700/80 bg-slate-950/80 px-2 py-1 font-mono text-[11px] text-slate-200 outline-none focus:border-cyan-500"
              >
                <option value="all">Semua (0–{maxObservedDepth})</option>
                {Array.from({ length: maxObservedDepth + 1 }, (_, d) => (
                  <option key={d} value={d}>
                    Depth ≤ {d}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="h-4 w-px bg-slate-800" />

          {/* Top-N Performance Filter */}
          <select
            value={topLimit === null ? 'all' : String(topLimit)}
            onChange={(e) =>
              setTopLimit(e.target.value === 'all' ? null : Number(e.target.value))
            }
            className="rounded-md border border-slate-700/80 bg-slate-950/80 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-cyan-500"
            title="Batasi jumlah node teratas di canvas untuk mengurangi lag"
          >
            <option value="all">Tampil: Semua ({nodes.length})</option>
            <option value="100">Tampil: Top 100 PR</option>
            <option value="250">Tampil: Top 250 PR</option>
            <option value="500">Tampil: Top 500 PR</option>
          </select>

          {/* Center Selector */}
          <div className="flex items-center gap-1">
            <select
              value={centerMode}
              onChange={(e) => setCenterMode(e.target.value as CenterMode)}
              className="rounded-md border border-slate-700/80 bg-slate-950/80 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-cyan-500"
              title="Pilih node pusat (center) graph"
            >
              <option value="seed">Center: Input Link</option>
              <option value="pagerank">Center: PageRank Tertinggi</option>
            </select>
            <button
              type="button"
              onClick={handleFocusCenter}
              disabled={nodes.length === 0}
              className="rounded-md p-1 text-slate-300 transition hover:bg-slate-800 hover:text-cyan-300 disabled:opacity-40"
              title="Fokus kamera ke Center"
            >
              <Crosshair className="h-3.5 w-3.5" />
            </button>
          </div>

          <select
            value={sizeMode}
            onChange={(e) => setSizeMode(e.target.value as SizeMode)}
            className="rounded-md border border-slate-700/80 bg-slate-950/80 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-cyan-500"
            title="Mode Ukuran Node"
          >
            <option value="pagerank">Ukuran: PageRank</option>
            <option value="in_degree">Ukuran: In-Degree</option>
            <option value="uniform">Ukuran: Seragam</option>
          </select>

          <select
            value={colorMode}
            onChange={(e) => setColorMode(e.target.value as ColorMode)}
            className="rounded-md border border-slate-700/80 bg-slate-950/80 px-2 py-1 text-[11px] text-slate-200 outline-none focus:border-cyan-500"
            title="Mode Pewarnaan Node"
          >
            <option value="depth">Warna: Depth</option>
            <option value="tld">Warna: Ekstensi (TLD)</option>
            <option value="status">Warna: HTTP Status</option>
            <option value="domain">Warna: Domain Hash</option>
          </select>

          {graphMode === 'domains' ? (
            <button
              type="button"
              onClick={() => setShowFavicons((v) => !v)}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition ${
                showFavicons
                  ? 'bg-slate-800 text-slate-200'
                  : 'bg-slate-950 text-slate-500 hover:text-slate-300'
              }`}
              title="Tampilkan / Sembunyikan Favicon Website"
            >
              {showFavicons ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              <span>Favicon</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowExternal((v) => !v)}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition ${
                showExternal
                  ? 'bg-slate-800 text-slate-200'
                  : 'bg-slate-950 text-slate-500 hover:text-slate-300'
              }`}
              title="Tampilkan / Sembunyikan Node Eksternal"
            >
              {showExternal ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
              <span>External</span>
            </button>
          )}
        </div>

        {/* Right Controls */}
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-xl border border-slate-800/90 bg-slate-900/90 px-2.5 py-2 shadow-xl backdrop-blur-md">
          <button
            type="button"
            onClick={handleTogglePhysics}
            disabled={nodes.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
            title={isPaused ? 'Lanjutkan Simulasi' : 'Jeda Simulasi'}
          >
            {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={handleZoomToFit}
            disabled={nodes.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
            title="Fit to Screen"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
          <div className="h-4 w-px bg-slate-800" />
          <button
            type="button"
            onClick={() => void handleExportCompactGzip()}
            disabled={nodes.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-emerald-300 transition hover:bg-slate-800 disabled:opacity-40"
            title="Unduh format kompak terkompresi (.json.gz) untuk di-upload ulang dengan cepat"
          >
            <Download className="h-3.5 w-3.5" />
            <span>.GZ</span>
          </button>
          <button
            type="button"
            onClick={handleExportJSON}
            disabled={nodes.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            <span>JSON</span>
          </button>
          <button
            type="button"
            onClick={handleExportCSV}
            disabled={links.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            <span>CSV</span>
          </button>
          <button
            type="button"
            onClick={handleExportPNG}
            disabled={nodes.length === 0}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800 disabled:opacity-40"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            <span>PNG</span>
          </button>
        </div>
      </div>

      {/* Empty State */}
      {nodes.length === 0 ? (
        <div className="relative z-0 flex h-full flex-col items-center justify-center p-8 text-center">
          <div className="max-w-md rounded-2xl border border-slate-800/80 bg-slate-900/60 p-6 backdrop-blur-sm">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/30">
              <Search className="h-6 w-6" />
            </div>
            <h2 className="mb-1.5 text-base font-semibold text-slate-100">
              {graphMode === 'domains'
                ? 'Petakan Jaringan Hubungan Antar-Website'
                : 'Petakan Struktur Link Internal Website'}
            </h2>
            <p className="mb-4 text-xs leading-relaxed text-slate-400">
              {graphMode === 'domains'
                ? 'Setiap domain website direpresentasikan sebagai 1 node (lengkap dengan favicon, PageRank & bobot relasi). Arahkan kursor ke node untuk melihat nama/URL & peringkat Rank, atau klik garis penghubung untuk detail tautan.'
                : 'Masukkan URL awal pada panel kiri, tentukan kedalaman depth = n, lalu klik Mulai Crawl untuk melihat hubungan antar-halaman secara real-time.'}
            </p>
            <div className="grid grid-cols-2 gap-2 text-left text-[11px] text-slate-400">
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                <span className="font-semibold text-cyan-300">1. Input Link</span>
                <p className="mt-0.5 text-[10px]">Dukung 1 atau Multi-Seed URL.</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                <span className="font-semibold text-indigo-300">2. Extract & Agregasi</span>
                <p className="mt-0.5 text-[10px]">Ekstrak link keluar & hitung bobot.</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                <span className="font-semibold text-purple-300">3. Loop Depth = n</span>
                <p className="mt-0.5 text-[10px]">Lompat antar-website hingga depth n.</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                <span className="font-semibold text-emerald-300">4. Graph Interaktif</span>
                <p className="mt-0.5 text-[10px]">Drag & drop .json/.gz atau crawl live.</p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <ForceGraph2D
          ref={fgRef}
          width={dimensions.width}
          height={dimensions.height}
          graphData={filteredData}
          backgroundColor="#020617"
          autoPauseRedraw={true}
          d3AlphaDecay={denseNodes ? 0.045 : 0.025}
          d3VelocityDecay={denseNodes ? 0.42 : 0.3}
          cooldownTicks={denseNodes ? 70 : 120}
          nodeId="id"
          nodeLabel={(n) => {
            const node = n as GraphNode;
            const pr = pageRankScores.get(node.id) ?? 0;
            const rank = rankPositions.get(node.id);
            const rankLabel = rank !== undefined ? `Rank #${rank}/${nodes.length}` : 'Rank -';
            return `${node.label}\n${node.url}\n${rankLabel} | PageRank: ${(pr * 100).toFixed(2)}%\nDepth: ${node.depth} | In: ${node.in_degree} | Out: ${node.out_degree}`;
          }}
          nodeCanvasObject={(node, ctx, globalScale) =>
            drawNode(node as GraphNode, ctx, globalScale)
          }
          nodePointerAreaPaint={(node, color, ctx) => {
            const n = node as GraphNode;
            const r = getNodeRadius(n) + 2;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
            ctx.fill();
          }}
          linkLabel={(link) => {
            const l = link as FastGraphEdge;
            const s = l._srcId ?? getEndpointId(l.source);
            const t = l._dstId ?? getEndpointId(l.target);
            const mutual = l._isMutual ? ' (Mutual Link)' : '';
            return `${s} → ${t}\n${l.weight ?? 1} link${mutual}`;
          }}
          linkColor={(link) => {
            const l = link as FastGraphEdge;
            const s = l._srcId ?? getEndpointId(l.source);
            const t = l._dstId ?? getEndpointId(l.target);
            if (selectedEdgeKey === `${s}\0${t}`) return '#facc15';
            const focusId = focusNodeIdRef.current;
            if (focusId) {
              return s === focusId || t === focusId
                ? l._isMutual
                  ? 'rgba(52, 211, 153, 0.9)'
                  : 'rgba(34, 211, 238, 0.85)'
                : 'rgba(148, 163, 184, 0.08)';
            }
            return l._isMutual ? 'rgba(52, 211, 153, 0.5)' : 'rgba(148, 163, 184, 0.28)';
          }}
          linkWidth={(link) => {
            const l = link as FastGraphEdge;
            const s = l._srcId ?? getEndpointId(l.source);
            const t = l._dstId ?? getEndpointId(l.target);
            const base = Math.min(4.5, 1 + Math.log2(Math.max(1, l.weight ?? 1)) * 0.9);
            if (selectedEdgeKey === `${s}\0${t}`) return base + 1.5;
            const focusId = focusNodeIdRef.current;
            if (!focusId) return base;
            return s === focusId || t === focusId ? base + 0.8 : 0.6;
          }}
          linkDirectionalArrowLength={(link) => {
            if (!denseEdges) return 4.5;
            const focusId = focusNodeIdRef.current;
            if (!focusId) return 0;
            const l = link as FastGraphEdge;
            const s = l._srcId ?? getEndpointId(l.source);
            const t = l._dstId ?? getEndpointId(l.target);
            return s === focusId || t === focusId ? 4.5 : 0;
          }}
          linkDirectionalArrowRelPos={1}
          linkDirectionalParticles={(link) => {
            if (denseEdges) return 0;
            const focusId = focusNodeIdRef.current;
            if (!focusId) return 0;
            const l = link as FastGraphEdge;
            return (l._srcId ?? getEndpointId(l.source)) === focusId ? 2 : 0;
          }}
          linkDirectionalParticleWidth={2}
          onNodeClick={(node) => {
            onSelectEdge(null);
            onSelectNode((node as GraphNode).id);
          }}
          onLinkClick={(link) => {
            onSelectNode(null);
            onSelectEdge(link as GraphEdge);
          }}
          onNodeHover={(node) => {
            syncFocusRefs(node ? (node as GraphNode).id : null, selectedNodeId);
          }}
          onBackgroundClick={() => {
            onSelectNode(null);
            onSelectEdge(null);
          }}
        />
      )}

      {/* Bottom Legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-slate-800/80 bg-slate-900/85 px-3 py-2 text-[11px] text-slate-300 backdrop-blur-md">
        {colorMode === 'depth' && (
          <>
            {['Seed (D0)', 'D1', 'D2', 'D3', 'D4+'].map((label, idx) => (
              <span key={label} className="flex items-center gap-1.5">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: DEPTH_PALETTE[idx] }}
                />
                {label}
              </span>
            ))}
            <span className="flex items-center gap-1.5 text-emerald-300">
              <span className="h-0.5 w-3 bg-emerald-400" />
              Mutual Link
            </span>
          </>
        )}
        {colorMode === 'tld' && (
          <>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-blue-400" /> .edu / .ac
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-400" /> .gov / .go
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-purple-400" /> .org / .io
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-400" /> .id
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" /> .com / Lainnya
            </span>
          </>
        )}
        {colorMode === 'status' && (
          <>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> 2xx OK
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> 3xx Redirect
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-500" /> 4xx/5xx/Err
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-slate-500" /> Uncrawled
            </span>
          </>
        )}
        {colorMode === 'domain' && <span>Warna otomatis berdasarkan hostname domain</span>}
        <span className="border-l border-slate-700 pl-3 text-slate-400">
          Center:{' '}
          <strong className="text-sky-300">
            {centerMode === 'seed' ? 'Input Link' : 'PageRank #1'}
          </strong>
        </span>
        <span className="border-l border-slate-700 pl-3 text-slate-400">
          Ukuran:{' '}
          <strong className="text-slate-200">
            {sizeMode === 'pagerank'
              ? 'PageRank (d=0.85)'
              : sizeMode === 'in_degree'
                ? 'In-Degree'
                : 'Seragam'}
          </strong>
        </span>
      </div>
    </main>
  );
};

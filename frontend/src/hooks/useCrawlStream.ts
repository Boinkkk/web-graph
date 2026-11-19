import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CrawlConfig,
  CrawlJobSummary,
  CrawlSnapshot,
  EdgeSample,
  GraphEdge,
  GraphNode,
  JobStatus,
} from '../types/graph';

interface UseCrawlStreamReturn {
  nodes: GraphNode[];
  links: GraphEdge[];
  summary: CrawlJobSummary | null;
  status: JobStatus;
  errorMessage: string | null;
  startCrawl: (config: CrawlConfig) => Promise<void>;
  stopCrawl: () => Promise<void>;
  resetGraph: () => void;
  loadGraphData: (
    nextNodes: GraphNode[],
    nextLinks: GraphEdge[],
    nextSummary: CrawlJobSummary | null
  ) => void;
}

export function useCrawlStream(): UseCrawlStreamReturn {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphEdge[]>([]);
  const [summary, setSummary] = useState<CrawlJobSummary | null>(null);
  const [status, setStatus] = useState<JobStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const nodesMapRef = useRef<Map<string, GraphNode>>(new Map());
  const linksMapRef = useRef<Map<string, GraphEdge>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const flushTimerRef = useRef<number | null>(null);

  const flushGraphState = useCallback(() => {
    if (flushTimerRef.current !== null) {
      window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    setNodes(Array.from(nodesMapRef.current.values()));
    setLinks(Array.from(linksMapRef.current.values()));
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    const nodeCount = nodesMapRef.current.size;
    const delayMs = nodeCount > 800 ? 400 : nodeCount > 300 ? 220 : 80;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      setNodes(Array.from(nodesMapRef.current.values()));
      setLinks(Array.from(linksMapRef.current.values()));
    }, delayMs);
  }, []);

  const closeStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      closeStream();
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
      }
    };
  }, [closeStream]);

  const upsertNode = useCallback((incoming: GraphNode) => {
    const existing = nodesMapRef.current.get(incoming.id);
    if (existing) {
      existing.label = incoming.label;
      existing.domain = incoming.domain;
      existing.depth = Math.min(existing.depth, incoming.depth);
      existing.status_code = incoming.status_code;
      existing.content_type = incoming.content_type;
      existing.error = incoming.error;
      existing.is_external = incoming.is_external;
      existing.crawled = incoming.crawled;
      existing.pages_sampled = Math.max(existing.pages_sampled ?? 0, incoming.pages_sampled ?? 0);
      existing.in_degree = Math.max(existing.in_degree, incoming.in_degree);
      existing.out_degree = Math.max(existing.out_degree, incoming.out_degree);
    } else {
      nodesMapRef.current.set(incoming.id, {
        ...incoming,
        pages_sampled: incoming.pages_sampled ?? 0,
      });
    }
  }, []);

  const upsertEdge = useCallback(
    (incoming: {
      source: string;
      target: string;
      weight?: number;
      samples?: EdgeSample[];
    }) => {
      const key = `${incoming.source}-->${incoming.target}`;
      const existing = linksMapRef.current.get(key);
      if (existing) {
        existing.weight = Math.max(existing.weight, incoming.weight ?? existing.weight + 1);
        if (incoming.samples && incoming.samples.length > 0) {
          existing.samples = incoming.samples;
        }
        return;
      }

      linksMapRef.current.set(key, {
        source: incoming.source,
        target: incoming.target,
        weight: incoming.weight ?? 1,
        samples: incoming.samples ?? [],
      });
      const srcNode = nodesMapRef.current.get(incoming.source);
      const dstNode = nodesMapRef.current.get(incoming.target);
      if (srcNode) srcNode.out_degree += 1;
      if (dstNode) dstNode.in_degree += 1;
    },
    []
  );

  const resetGraph = useCallback(() => {
    closeStream();
    activeJobIdRef.current = null;
    nodesMapRef.current.clear();
    linksMapRef.current.clear();
    setNodes([]);
    setLinks([]);
    setSummary(null);
    setStatus('idle');
    setErrorMessage(null);
  }, [closeStream]);

  const loadGraphData = useCallback(
    (
      nextNodes: GraphNode[],
      nextLinks: GraphEdge[],
      nextSummary: CrawlJobSummary | null
    ) => {
      closeStream();
      activeJobIdRef.current = nextSummary?.job_id ?? null;
      nodesMapRef.current.clear();
      linksMapRef.current.clear();

      for (const node of nextNodes) {
        nodesMapRef.current.set(node.id, {
          ...node,
          pages_sampled: node.pages_sampled ?? 0,
        });
      }
      for (const edge of nextLinks) {
        const s = typeof edge.source === 'string' ? edge.source : edge.source.id;
        const t = typeof edge.target === 'string' ? edge.target : edge.target.id;
        linksMapRef.current.set(`${s}-->${t}`, {
          source: s,
          target: t,
          weight: edge.weight ?? 1,
          samples: edge.samples ?? [],
        });
      }

      setSummary(nextSummary);
      setStatus(nextSummary?.status ?? 'completed');
      setErrorMessage(null);
      flushGraphState();
    },
    [closeStream, flushGraphState]
  );

  const startCrawl = useCallback(
    async (config: CrawlConfig) => {
      closeStream();
      nodesMapRef.current.clear();
      linksMapRef.current.clear();
      setNodes([]);
      setLinks([]);
      setSummary(null);
      setErrorMessage(null);
      setStatus('running');

      try {
        const res = await fetch('/api/crawl', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.detail || `Request failed (${res.status})`);
        }

        const initialSummary: CrawlJobSummary = await res.json();
        activeJobIdRef.current = initialSummary.job_id;
        setSummary(initialSummary);

        const es = new EventSource(`/api/crawl/${initialSummary.job_id}/stream`);
        eventSourceRef.current = es;

        es.addEventListener('snapshot', (evt) => {
          const snap: CrawlSnapshot = JSON.parse((evt as MessageEvent).data);
          nodesMapRef.current.clear();
          linksMapRef.current.clear();
          for (const node of snap.nodes) {
            nodesMapRef.current.set(node.id, {
              ...node,
              pages_sampled: node.pages_sampled ?? 0,
            });
          }
          for (const link of snap.links) {
            linksMapRef.current.set(`${link.source}-->${link.target}`, {
              source: link.source,
              target: link.target,
              weight: link.weight ?? 1,
              samples: link.samples ?? [],
            });
          }
          setSummary(snap.summary);
          setStatus(snap.summary.status);
          flushGraphState();
        });

        es.addEventListener('node', (evt) => {
          const node: GraphNode = JSON.parse((evt as MessageEvent).data);
          upsertNode(node);
          scheduleFlush();
        });

        es.addEventListener('edge', (evt) => {
          const edge: {
            source: string;
            target: string;
            weight?: number;
            samples?: EdgeSample[];
          } = JSON.parse((evt as MessageEvent).data);
          upsertEdge(edge);
          scheduleFlush();
        });

        es.addEventListener('progress', (evt) => {
          const prog: CrawlJobSummary = JSON.parse((evt as MessageEvent).data);
          setSummary(prog);
        });

        es.addEventListener('done', (evt) => {
          const finalSummary: CrawlJobSummary = JSON.parse((evt as MessageEvent).data);
          setSummary(finalSummary);
          setStatus(finalSummary.status);
          if (finalSummary.error) {
            setErrorMessage(finalSummary.error);
          }
          flushGraphState();
          closeStream();
        });

        es.onerror = () => {
          if (activeJobIdRef.current && eventSourceRef.current) {
            const jobId = activeJobIdRef.current;
            closeStream();
            fetch(`/api/crawl/${jobId}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((snap: CrawlSnapshot | null) => {
                if (!snap) return;
                setSummary(snap.summary);
                setStatus(snap.summary.status);
                flushGraphState();
              })
              .catch(() => {});
          }
        };
      } catch (err) {
        setStatus('failed');
        setErrorMessage(err instanceof Error ? err.message : 'Gagal memulai crawling.');
      }
    },
    [closeStream, flushGraphState, scheduleFlush, upsertEdge, upsertNode]
  );

  const stopCrawl = useCallback(async () => {
    const jobId = activeJobIdRef.current;
    if (!jobId) return;
    try {
      const res = await fetch(`/api/crawl/${jobId}/stop`, { method: 'POST' });
      if (res.ok) {
        const stoppedSummary: CrawlJobSummary = await res.json();
        setSummary(stoppedSummary);
        setStatus('stopped');
      }
    } catch {
      // ignore network errors during stop
    }
  }, []);

  return {
    nodes,
    links,
    summary,
    status,
    errorMessage,
    startCrawl,
    stopCrawl,
    resetGraph,
    loadGraphData,
  };
}

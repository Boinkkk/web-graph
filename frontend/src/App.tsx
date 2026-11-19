import { useCallback, useEffect, useMemo, useState } from 'react';
import { CrawlForm } from './components/CrawlForm';
import { EdgeInspector } from './components/EdgeInspector';
import { GraphCanvas } from './components/GraphCanvas';
import { NodeInspector } from './components/NodeInspector';
import { useCrawlStream } from './hooks/useCrawlStream';
import type { CrawlConfig, CrawlSnapshot, GraphEdge, GraphNode, SavedCrawlMeta } from './types/graph';
import { parseUploadedGraphFile } from './utils/graphFile';
import { computePageRank, computePageRankPositions } from './utils/pagerank';

const INITIAL_CONFIG: CrawlConfig = {
  url: 'https://news.ycombinator.com',
  extra_urls: [],
  graph_mode: 'domains',
  max_depth: 2,
  max_pages: 80,
  max_pages_per_domain: 2,
  scope: 'internal',
  include_external_leaves: true,
  exclude_common_platforms: true,
  ignored_domains: [],
  concurrency: 5,
  respect_robots: true,
};

function getEndpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

export function App() {
  const [config, setConfig] = useState<CrawlConfig>(INITIAL_CONFIG);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [savedCrawls, setSavedCrawls] = useState<SavedCrawlMeta[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const {
    nodes,
    links,
    summary,
    status,
    errorMessage,
    startCrawl,
    stopCrawl,
    resetGraph,
    loadGraphData,
  } = useCrawlStream();

  const refreshSavedCrawls = useCallback(async () => {
    try {
      const res = await fetch('/api/saved');
      if (!res.ok) return;
      const list: SavedCrawlMeta[] = await res.json();
      setSavedCrawls(list);
    } catch {
      // Backend may be offline when using standalone client-side upload visualization
    }
  }, []);

  useEffect(() => {
    void refreshSavedCrawls();
  }, [refreshSavedCrawls]);

  useEffect(() => {
    if (status === 'completed' || status === 'stopped') {
      void refreshSavedCrawls();
    }
  }, [status, refreshSavedCrawls]);

  const nodesById = useMemo(() => {
    const map = new Map<string, GraphNode>();
    for (const node of nodes) {
      map.set(node.id, node);
    }
    return map;
  }, [nodes]);

  const activeGraphMode = summary?.graph_mode ?? config.graph_mode;
  const pageRankScores = useMemo(() => computePageRank(nodes, links), [nodes, links]);
  const rankPositions = useMemo(
    () => computePageRankPositions(pageRankScores),
    [pageRankScores]
  );
  const selectedNode = selectedNodeId ? nodesById.get(selectedNodeId) ?? null : null;

  const hasReverseEdge = useMemo(() => {
    if (!selectedEdge) return false;
    const src = getEndpointId(selectedEdge.source);
    const dst = getEndpointId(selectedEdge.target);
    return links.some(
      (edge) => getEndpointId(edge.source) === dst && getEndpointId(edge.target) === src
    );
  }, [links, selectedEdge]);

  const handleStart = () => {
    setUploadError(null);
    setSelectedNodeId(null);
    setSelectedEdge(null);
    void startCrawl(config);
  };

  const handleReset = () => {
    setUploadError(null);
    setSelectedNodeId(null);
    setSelectedEdge(null);
    resetGraph();
  };

  const handleRecrawlFromNode = (url: string) => {
    setUploadError(null);
    const nextConfig: CrawlConfig = { ...config, url, extra_urls: [] };
    setConfig(nextConfig);
    setSelectedNodeId(null);
    setSelectedEdge(null);
    void startCrawl(nextConfig);
  };

  const handleLoadSaved = useCallback(
    async (jobId: string) => {
      setUploadError(null);
      try {
        const res = await fetch(`/api/saved/${jobId}`);
        if (!res.ok) {
          throw new Error('Gagal memuat data crawl tersimpan.');
        }
        const snap: CrawlSnapshot = await res.json();
        setSelectedNodeId(null);
        setSelectedEdge(null);
        setConfig((prev) => ({
          ...prev,
          graph_mode: snap.summary.graph_mode,
          url: snap.summary.seed_url,
          max_depth: snap.summary.max_depth,
          max_pages: snap.summary.max_pages,
        }));
        loadGraphData(
          snap.nodes,
          snap.links.map((l) => ({
            source: l.source,
            target: l.target,
            weight: l.weight ?? 1,
            samples: l.samples ?? [],
          })),
          snap.summary
        );
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Gagal memuat graph tersimpan.');
      }
    },
    [loadGraphData]
  );

  const handleDeleteSaved = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/saved/${jobId}`, { method: 'DELETE' });
      if (res.ok) {
        setSavedCrawls((prev) => prev.filter((item) => item.job_id !== jobId));
      }
    } catch {
      // ignore network error
    }
  }, []);

  const handleUploadFile = useCallback(
    async (file: File) => {
      setUploadError(null);
      try {
        const parsed = await parseUploadedGraphFile(file);
        setSelectedNodeId(null);
        setSelectedEdge(null);
        setConfig((prev) => ({
          ...prev,
          graph_mode: parsed.graphMode,
          url: parsed.summary?.seed_url ?? prev.url,
        }));
        loadGraphData(
          parsed.nodes,
          parsed.links,
          parsed.summary ?? {
            job_id: `upload-${Date.now()}`,
            status: 'completed',
            graph_mode: parsed.graphMode,
            seed_url: parsed.nodes[0]?.url ?? file.name,
            max_depth: Math.max(0, ...parsed.nodes.map((n) => n.depth)),
            max_pages: parsed.nodes.length,
            pages_crawled: parsed.nodes.length,
            nodes_count: parsed.nodes.length,
            edges_count: parsed.links.length,
            error: null,
          }
        );
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Gagal membaca file graph.');
      }
    },
    [loadGraphData]
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100">
      <CrawlForm
        config={config}
        onChange={setConfig}
        onStart={handleStart}
        onStop={() => void stopCrawl()}
        onReset={handleReset}
        status={status}
        summary={summary}
        errorMessage={uploadError ?? errorMessage}
        nodes={nodes}
        activeGraphMode={activeGraphMode}
        pageRankScores={pageRankScores}
        rankPositions={rankPositions}
        selectedNodeId={selectedNodeId}
        onSelectNode={(id) => {
          setSelectedEdge(null);
          setSelectedNodeId(id);
        }}
        nodeCount={nodes.length}
        edgeCount={links.length}
        savedCrawls={savedCrawls}
        onLoadSaved={(id) => void handleLoadSaved(id)}
        onDeleteSaved={(id) => void handleDeleteSaved(id)}
        onUploadFile={(file) => void handleUploadFile(file)}
      />

      <GraphCanvas
        nodes={nodes}
        links={links}
        graphMode={activeGraphMode}
        summary={summary}
        maxDepthConfigured={summary?.max_depth ?? config.max_depth}
        pageRankScores={pageRankScores}
        rankPositions={rankPositions}
        selectedNodeId={selectedNodeId}
        selectedEdge={selectedEdge}
        onSelectNode={(id) => {
          setSelectedEdge(null);
          setSelectedNodeId(id);
        }}
        onSelectEdge={(edge) => {
          setSelectedNodeId(null);
          setSelectedEdge(edge);
        }}
        onUploadFile={(file) => void handleUploadFile(file)}
      />

      {selectedNode && (
        <NodeInspector
          node={selectedNode}
          graphMode={activeGraphMode}
          pageRankScore={pageRankScores.get(selectedNode.id) ?? 0}
          rankPosition={rankPositions.get(selectedNode.id) ?? null}
          totalNodes={nodes.length}
          nodesById={nodesById}
          links={links}
          onClose={() => setSelectedNodeId(null)}
          onSelectNode={(id) => {
            setSelectedEdge(null);
            setSelectedNodeId(id);
          }}
          onSelectEdge={(edge) => {
            setSelectedNodeId(null);
            setSelectedEdge(edge);
          }}
          onRecrawlFromNode={handleRecrawlFromNode}
          isRunning={status === 'running'}
        />
      )}

      {!selectedNode && selectedEdge && (
        <EdgeInspector
          edge={selectedEdge}
          hasReverseEdge={hasReverseEdge}
          nodesById={nodesById}
          onClose={() => setSelectedEdge(null)}
          onSelectNode={(id) => {
            setSelectedEdge(null);
            setSelectedNodeId(id);
          }}
        />
      )}
    </div>
  );
}

export default App;

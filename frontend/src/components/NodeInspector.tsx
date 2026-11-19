import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Compass,
  ExternalLink,
  X,
} from 'lucide-react';
import type { GraphEdge, GraphMode, GraphNode } from '../types/graph';

const LINK_PAGE_SIZE = 50;

interface NodeInspectorProps {
  node: GraphNode;
  graphMode: GraphMode;
  pageRankScore: number;
  rankPosition: number | null;
  totalNodes: number;
  nodesById: Map<string, GraphNode>;
  links: GraphEdge[];
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
  onSelectEdge: (edge: GraphEdge) => void;
  onRecrawlFromNode: (url: string) => void;
  isRunning: boolean;
}

function getEndpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

function statusColorClass(node: GraphNode): string {
  if (node.error) return 'bg-rose-500/15 text-rose-300 border-rose-500/40';
  if (node.status_code === null) return 'bg-slate-800 text-slate-300 border-slate-700';
  if (node.status_code >= 200 && node.status_code < 300) {
    return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  }
  if (node.status_code >= 300 && node.status_code < 400) {
    return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
  }
  return 'bg-rose-500/15 text-rose-300 border-rose-500/40';
}

export const NodeInspector: React.FC<NodeInspectorProps> = ({
  node,
  graphMode,
  pageRankScore,
  rankPosition,
  totalNodes,
  nodesById,
  links,
  onClose,
  onSelectNode,
  onSelectEdge,
  onRecrawlFromNode,
  isRunning,
}) => {
  const [outPage, setOutPage] = useState(1);
  const [inPage, setInPage] = useState(1);

  useEffect(() => {
    setOutPage(1);
    setInPage(1);
  }, [node.id]);

  const { incoming, outgoing } = useMemo(() => {
    const inc: Array<{ peer: GraphNode; edge: GraphEdge }> = [];
    const out: Array<{ peer: GraphNode; edge: GraphEdge }> = [];
    const seenInc = new Set<string>();
    const seenOut = new Set<string>();

    for (const edge of links) {
      const src = getEndpointId(edge.source);
      const dst = getEndpointId(edge.target);
      if (dst === node.id && !seenInc.has(src)) {
        seenInc.add(src);
        const found = nodesById.get(src);
        if (found) inc.push({ peer: found, edge });
      }
      if (src === node.id && !seenOut.has(dst)) {
        seenOut.add(dst);
        const found = nodesById.get(dst);
        if (found) out.push({ peer: found, edge });
      }
    }

    inc.sort((a, b) => (b.edge.weight ?? 1) - (a.edge.weight ?? 1));
    out.sort((a, b) => (b.edge.weight ?? 1) - (a.edge.weight ?? 1));
    return { incoming: inc, outgoing: out };
  }, [links, node.id, nodesById]);

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-slate-800/80 bg-slate-900/95 backdrop-blur-md">
      <div className="flex items-start justify-between gap-2 border-b border-slate-800 px-4 py-3.5">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-cyan-300">
              Depth {node.depth}
            </span>
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${statusColorClass(node)}`}
            >
              {node.error
                ? 'Error'
                : node.status_code !== null
                  ? `HTTP ${node.status_code}`
                  : 'Belum di-crawl'}
            </span>
            {node.is_external && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
                External
              </span>
            )}
          </div>
          <h2 className="truncate text-sm font-semibold text-slate-100" title={node.label}>
            {node.label}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
          aria-label="Tutup inspector"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 text-xs">
        <div>
          <div className="mb-1 text-[11px] font-medium text-slate-400">
            {graphMode === 'domains' ? 'Sample Entry URL' : 'URL'}
          </div>
          <a
            href={node.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-start gap-1.5 break-all rounded-lg border border-slate-800 bg-slate-950/70 p-2.5 text-cyan-300 transition hover:border-cyan-500/40 hover:text-cyan-200"
          >
            <span className="flex-1">{node.url}</span>
            <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          </a>
        </div>

        {node.error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-rose-300">
            {node.error}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
            <div className="text-[10px] text-slate-400">
              {rankPosition !== null ? `Rank #${rankPosition}/${totalNodes}` : 'PageRank'}
            </div>
            <div className="font-mono text-xs font-semibold text-cyan-300">
              {(pageRankScore * 100).toFixed(2)}%
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
            <div className="text-[10px] text-slate-400">Domain</div>
            <div className="truncate font-mono text-xs text-slate-200" title={node.domain}>
              {node.domain}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5">
            <div className="text-[10px] text-slate-400">
              {graphMode === 'domains' ? 'Sampling' : 'Tipe'}
            </div>
            <div className="truncate font-mono text-xs text-slate-200">
              {graphMode === 'domains' ? `${node.pages_sampled} hal` : node.content_type || '-'}
            </div>
          </div>
        </div>

        <button
          type="button"
          disabled={isRunning}
          onClick={() => onRecrawlFromNode(node.url)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/20 disabled:opacity-40"
        >
          <Compass className="h-3.5 w-3.5" />
          Jadikan Seed URL & Crawl Ulang
        </button>

        {/* Outgoing links */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-slate-300">
            <span className="flex items-center gap-1">
              <ArrowUpRight className="h-3.5 w-3.5 text-indigo-400" />
              {graphMode === 'domains' ? 'Merujuk ke Website' : 'Outgoing Links'} ({outgoing.length})
            </span>
          </div>
          {outgoing.length === 0 ? (
            <p className="rounded-lg border border-slate-800/70 bg-slate-950/40 p-2.5 text-[11px] text-slate-500">
              Tidak ada outgoing link tercatat.
            </p>
          ) : (
            <>
              <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
                {outgoing
                  .slice((outPage - 1) * LINK_PAGE_SIZE, outPage * LINK_PAGE_SIZE)
                  .map(({ peer, edge }) => (
                    <li key={peer.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSelectNode(peer.id)}
                        className="min-w-0 flex-1 truncate rounded-md border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5 text-left text-[11px] text-slate-300 transition hover:border-cyan-500/40 hover:text-cyan-200"
                        title={peer.url}
                      >
                        <span className="mr-1.5 font-mono text-[10px] text-slate-500">
                          D{peer.depth}
                        </span>
                        {graphMode === 'domains' ? peer.domain : peer.label}
                      </button>
                      {edge.weight > 0 && (
                        <button
                          type="button"
                          onClick={() => onSelectEdge(edge)}
                          className="shrink-0 rounded border border-slate-800 bg-slate-950/80 px-1.5 py-1 font-mono text-[10px] text-indigo-300 hover:border-indigo-500/50"
                          title="Lihat detail URL penghubung"
                        >
                          ×{edge.weight}
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
              {outgoing.length > LINK_PAGE_SIZE && (
                <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400">
                  <button
                    type="button"
                    disabled={outPage <= 1}
                    onClick={() => setOutPage((p) => Math.max(1, p - 1))}
                    className="flex items-center gap-0.5 rounded border border-slate-800 px-1.5 py-0.5 hover:text-white disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3 w-3" /> Prev
                  </button>
                  <span className="font-mono">
                    {outPage} / {Math.ceil(outgoing.length / LINK_PAGE_SIZE)}
                  </span>
                  <button
                    type="button"
                    disabled={outPage >= Math.ceil(outgoing.length / LINK_PAGE_SIZE)}
                    onClick={() =>
                      setOutPage((p) =>
                        Math.min(Math.ceil(outgoing.length / LINK_PAGE_SIZE), p + 1)
                      )
                    }
                    className="flex items-center gap-0.5 rounded border border-slate-800 px-1.5 py-0.5 hover:text-white disabled:opacity-40"
                  >
                    Next <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Incoming links */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-slate-300">
            <span className="flex items-center gap-1">
              <ArrowDownLeft className="h-3.5 w-3.5 text-emerald-400" />
              {graphMode === 'domains' ? 'Dirujuk oleh Website' : 'Incoming Links'} ({incoming.length})
            </span>
          </div>
          {incoming.length === 0 ? (
            <p className="rounded-lg border border-slate-800/70 bg-slate-950/40 p-2.5 text-[11px] text-slate-500">
              Ini adalah root/seed atau belum ada node lain yang mengarah ke sini.
            </p>
          ) : (
            <>
              <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
                {incoming
                  .slice((inPage - 1) * LINK_PAGE_SIZE, inPage * LINK_PAGE_SIZE)
                  .map(({ peer, edge }) => (
                    <li key={peer.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onSelectNode(peer.id)}
                        className="min-w-0 flex-1 truncate rounded-md border border-slate-800/80 bg-slate-950/60 px-2.5 py-1.5 text-left text-[11px] text-slate-300 transition hover:border-cyan-500/40 hover:text-cyan-200"
                        title={peer.url}
                      >
                        <span className="mr-1.5 font-mono text-[10px] text-slate-500">
                          D{peer.depth}
                        </span>
                        {graphMode === 'domains' ? peer.domain : peer.label}
                      </button>
                      {edge.weight > 0 && (
                        <button
                          type="button"
                          onClick={() => onSelectEdge(edge)}
                          className="shrink-0 rounded border border-slate-800 bg-slate-950/80 px-1.5 py-1 font-mono text-[10px] text-emerald-300 hover:border-emerald-500/50"
                          title="Lihat detail URL penghubung"
                        >
                          ×{edge.weight}
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
              {incoming.length > LINK_PAGE_SIZE && (
                <div className="mt-1.5 flex items-center justify-between text-[10px] text-slate-400">
                  <button
                    type="button"
                    disabled={inPage <= 1}
                    onClick={() => setInPage((p) => Math.max(1, p - 1))}
                    className="flex items-center gap-0.5 rounded border border-slate-800 px-1.5 py-0.5 hover:text-white disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3 w-3" /> Prev
                  </button>
                  <span className="font-mono">
                    {inPage} / {Math.ceil(incoming.length / LINK_PAGE_SIZE)}
                  </span>
                  <button
                    type="button"
                    disabled={inPage >= Math.ceil(incoming.length / LINK_PAGE_SIZE)}
                    onClick={() =>
                      setInPage((p) =>
                        Math.min(Math.ceil(incoming.length / LINK_PAGE_SIZE), p + 1)
                      )
                    }
                    className="flex items-center gap-0.5 rounded border border-slate-800 px-1.5 py-0.5 hover:text-white disabled:opacity-40"
                  >
                    Next <ChevronRight className="h-3 w-3" />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </aside>
  );
};

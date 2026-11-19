import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Search, Trophy } from 'lucide-react';
import type { GraphMode, GraphNode } from '../types/graph';

interface RankingPanelProps {
  nodes: GraphNode[];
  graphMode: GraphMode;
  pageRankScores: Map<string, number>;
  rankPositions: Map<string, number>;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}

type DepthFilter = 'all' | 'seed' | 'non_seed';

const PAGE_SIZE = 50;

function rankBadgeClass(rank: number): string {
  if (rank === 1) return 'bg-amber-400/20 text-amber-300 border-amber-400/50';
  if (rank === 2) return 'bg-slate-300/20 text-slate-200 border-slate-300/40';
  if (rank === 3) return 'bg-orange-400/20 text-orange-300 border-orange-400/40';
  return 'bg-slate-800/90 text-slate-400 border-slate-700/80';
}

export const RankingPanel: React.FC<RankingPanelProps> = ({
  nodes,
  graphMode,
  pageRankScores,
  rankPositions,
  selectedNodeId,
  onSelectNode,
}) => {
  const [query, setQuery] = useState('');
  const [depthFilter, setDepthFilter] = useState<DepthFilter>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const listRef = useRef<HTMLUListElement | null>(null);

  const sortedNodes = useMemo(() => {
    return [...nodes].sort((a, b) => {
      const rankA = rankPositions.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rankB = rankPositions.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return rankA - rankB;
    });
  }, [nodes, rankPositions]);

  const topScore = useMemo(() => {
    if (sortedNodes.length === 0) return 0;
    return pageRankScores.get(sortedNodes[0].id) ?? 0;
  }, [sortedNodes, pageRankScores]);

  const filteredNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortedNodes.filter((node) => {
      if (depthFilter === 'seed' && node.depth !== 0) return false;
      if (depthFilter === 'non_seed' && node.depth === 0) return false;
      if (!q) return true;
      return (
        node.domain.toLowerCase().includes(q) ||
        node.label.toLowerCase().includes(q) ||
        node.url.toLowerCase().includes(q)
      );
    });
  }, [sortedNodes, query, depthFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredNodes.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);

  useEffect(() => {
    setCurrentPage(1);
  }, [query, depthFilter]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedNodes = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredNodes.slice(start, start + PAGE_SIZE);
  }, [filteredNodes, safePage]);

  const goToPage = (page: number) => {
    const clamped = Math.max(1, Math.min(totalPages, page));
    setCurrentPage(clamped);
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleExportRankingCSV = () => {
    const header = 'rank,domain,label,url,depth,pagerank_percent,in_degree,out_degree\n';
    const rows = sortedNodes
      .map((node) => {
        const rank = rankPositions.get(node.id) ?? 0;
        const pct = ((pageRankScores.get(node.id) ?? 0) * 100).toFixed(4);
        const safeLabel = node.label.replace(/"/g, '""');
        return `${rank},"${node.domain}","${safeLabel}","${node.url}",${node.depth},${pct},${node.in_degree},${node.out_degree}`;
      })
      .join('\n');

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `web-graph-pagerank-${graphMode}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (nodes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/30">
          <Trophy className="h-5 w-5" />
        </div>
        <p className="text-xs font-medium text-slate-300">Belum Ada Data Ranking</p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          Jalankan crawl atau upload file graph terlebih dahulu untuk melihat peringkat PageRank.
        </p>
      </div>
    );
  }

  const rangeStart = filteredNodes.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(filteredNodes.length, safePage * PAGE_SIZE);

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-hidden p-4">
      {/* Header & Export */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] text-slate-400">
          Menampilkan <span className="font-mono text-slate-200">{rangeStart}–{rangeEnd}</span> dari{' '}
          <span className="font-mono text-slate-200">{filteredNodes.length}</span>{' '}
          {graphMode === 'domains' ? 'website' : 'halaman'}
        </div>
        <button
          type="button"
          onClick={handleExportRankingCSV}
          className="flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300 transition hover:border-cyan-500/50 hover:text-cyan-300"
          title="Unduh tabel ranking PageRank sebagai CSV"
        >
          <Download className="h-3 w-3" />
          CSV
        </button>
      </div>

      {/* Search & Depth Filter */}
      <div className="flex flex-col gap-2">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={graphMode === 'domains' ? 'Filter domain...' : 'Filter URL / judul...'}
            className="w-full rounded-lg border border-slate-700 bg-slate-950/80 py-1.5 pr-2.5 pl-8 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-500"
          />
        </div>

        <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-950/70 p-0.5 text-[10px]">
          {[
            { id: 'all', label: 'Semua' },
            { id: 'seed', label: 'Seed (D0)' },
            { id: 'non_seed', label: 'Lainnya (D≥1)' },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setDepthFilter(opt.id as DepthFilter)}
              className={`rounded-md py-1 font-medium transition ${
                depthFilter === opt.id
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Ranked List (50 items per page) */}
      <ul ref={listRef} className="flex flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
        {paginatedNodes.length === 0 ? (
          <li className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-center text-xs text-slate-500">
            Tidak ada hasil yang cocok.
          </li>
        ) : (
          paginatedNodes.map((node) => {
            const rank = rankPositions.get(node.id) ?? 0;
            const score = pageRankScores.get(node.id) ?? 0;
            const pct = (score * 100).toFixed(2);
            const barWidth = topScore > 0 ? Math.max(4, Math.round((score / topScore) * 100)) : 0;
            const isSelected = selectedNodeId === node.id;

            return (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => onSelectNode(node.id)}
                  className={`w-full rounded-xl border p-2.5 text-left transition ${
                    isSelected
                      ? 'border-cyan-400/70 bg-cyan-500/10'
                      : 'border-slate-800/90 bg-slate-950/60 hover:border-slate-700 hover:bg-slate-900/80'
                  }`}
                  title={node.url}
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span
                        className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${rankBadgeClass(rank)}`}
                      >
                        #{rank}
                      </span>
                      <span className="truncate text-xs font-medium text-slate-100">
                        {graphMode === 'domains' ? node.domain : node.label}
                      </span>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] font-semibold text-cyan-300">
                      {pct}%
                    </span>
                  </div>

                  <div className="mb-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-cyan-400 to-indigo-400"
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-slate-400">
                    <span className="truncate pr-2 text-slate-500">
                      {graphMode === 'domains' ? node.label : node.url}
                    </span>
                    <span className="shrink-0 font-mono">
                      D{node.depth} · In {node.in_degree} · Out {node.out_degree}
                    </span>
                  </div>
                </button>
              </li>
            );
          })
        )}
      </ul>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-slate-800 pt-2.5 text-[11px]">
          <button
            type="button"
            disabled={safePage <= 1}
            onClick={() => goToPage(safePage - 1)}
            className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-300 transition hover:border-slate-700 hover:text-white disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </button>

          <span className="font-mono text-slate-400">
            Hal <strong className="text-slate-200">{safePage}</strong> / {totalPages}
          </span>

          <button
            type="button"
            disabled={safePage >= totalPages}
            onClick={() => goToPage(safePage + 1)}
            className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-300 transition hover:border-slate-700 hover:text-white disabled:opacity-40"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

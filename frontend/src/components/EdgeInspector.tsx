import React from 'react';
import { ArrowLeftRight, ArrowRight, ExternalLink, X } from 'lucide-react';
import type { GraphEdge, GraphNode } from '../types/graph';

interface EdgeInspectorProps {
  edge: GraphEdge;
  hasReverseEdge: boolean;
  nodesById: Map<string, GraphNode>;
  onClose: () => void;
  onSelectNode: (nodeId: string) => void;
}

function getEndpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

export const EdgeInspector: React.FC<EdgeInspectorProps> = ({
  edge,
  hasReverseEdge,
  nodesById,
  onClose,
  onSelectNode,
}) => {
  const sourceId = getEndpointId(edge.source);
  const targetId = getEndpointId(edge.target);
  const sourceNode = nodesById.get(sourceId);
  const targetNode = nodesById.get(targetId);

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-slate-800/80 bg-slate-900/95 backdrop-blur-md">
      <div className="flex items-start justify-between gap-2 border-b border-slate-800 px-4 py-3.5">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-indigo-300">
              Weight: {edge.weight} link
            </span>
            {hasReverseEdge && (
              <span className="flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                <ArrowLeftRight className="h-3 w-3" />
                Mutual Link
              </span>
            )}
          </div>
          <h2 className="truncate text-sm font-semibold text-slate-100">Detail Relasi Link</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
          aria-label="Tutup edge inspector"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 text-xs">
        <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
          <button
            type="button"
            onClick={() => onSelectNode(sourceId)}
            className="truncate text-left font-medium text-cyan-300 hover:underline"
            title={sourceId}
          >
            {sourceNode?.domain || sourceId}
          </button>
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
            <ArrowRight className="h-3.5 w-3.5 text-indigo-400" />
            <span>mengarah ke</span>
          </div>
          <button
            type="button"
            onClick={() => onSelectNode(targetId)}
            className="truncate text-left font-medium text-indigo-300 hover:underline"
            title={targetId}
          >
            {targetNode?.domain || targetId}
          </button>
        </div>

        <div>
          <div className="mb-2 text-[11px] font-medium text-slate-300">
            Sampel URL Penghubung ({edge.samples.length})
          </div>
          {edge.samples.length === 0 ? (
            <p className="rounded-lg border border-slate-800 bg-slate-950/50 p-2.5 text-[11px] text-slate-500">
              Relasi langsung antar halaman ({sourceId} → {targetId}).
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {edge.samples.map((sample, idx) => (
                <li
                  key={`${sample.from_url}->${sample.to_url}-${idx}`}
                  className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"
                >
                  <div className="mb-1 text-[10px] text-slate-400">Dari halaman:</div>
                  <a
                    href={sample.from_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mb-2 flex items-start gap-1 break-all text-[11px] text-slate-300 hover:text-cyan-300"
                  >
                    <span className="flex-1">{sample.from_url}</span>
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                  </a>
                  <div className="mb-1 text-[10px] text-slate-400">Menuju URL:</div>
                  <a
                    href={sample.to_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-start gap-1 break-all text-[11px] text-cyan-300 hover:text-cyan-200"
                  >
                    <span className="flex-1">{sample.to_url}</span>
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
};

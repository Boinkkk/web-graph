import React, { useRef, useState } from 'react';
import {
  Database,
  Download,
  FileCode2,
  FolderOpen,
  Globe,
  Layers,
  Network,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Trophy,
  Upload,
} from 'lucide-react';
import type {
  CrawlConfig,
  CrawlJobSummary,
  CrawlScope,
  GraphMode,
  GraphNode,
  JobStatus,
  SavedCrawlMeta,
} from '../types/graph';
import { RankingPanel } from './RankingPanel';

interface CrawlFormProps {
  config: CrawlConfig;
  onChange: (next: CrawlConfig) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  status: JobStatus;
  summary: CrawlJobSummary | null;
  errorMessage: string | null;
  nodes: GraphNode[];
  activeGraphMode: GraphMode;
  pageRankScores: Map<string, number>;
  rankPositions: Map<string, number>;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  nodeCount: number;
  edgeCount: number;
  savedCrawls: SavedCrawlMeta[];
  onLoadSaved: (jobId: string) => void;
  onDeleteSaved: (jobId: string) => void;
  onUploadFile: (file: File) => void;
}

const STATUS_BADGE: Record<JobStatus, { label: string; cls: string }> = {
  idle: { label: 'Siap', cls: 'bg-slate-800 text-slate-300 border-slate-700' },
  running: {
    label: 'Crawling...',
    cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40 animate-pulse',
  },
  completed: {
    label: 'Selesai',
    cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  },
  stopped: {
    label: 'Dihentikan',
    cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  },
  failed: {
    label: 'Gagal',
    cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
  },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export const CrawlForm: React.FC<CrawlFormProps> = ({
  config,
  onChange,
  onStart,
  onStop,
  onReset,
  status,
  summary,
  errorMessage,
  nodes,
  activeGraphMode,
  pageRankScores,
  rankPositions,
  selectedNodeId,
  onSelectNode,
  nodeCount,
  edgeCount,
  savedCrawls,
  onLoadSaved,
  onDeleteSaved,
  onUploadFile,
}) => {
  const isRunning = status === 'running';
  const badge = STATUS_BADGE[status];
  const [activeTab, setActiveTab] = useState<'crawl' | 'ranking' | 'saved'>('crawl');
  const [ignoredText, setIgnoredText] = useState(config.ignored_domains.join(', '));
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isRunning) onStart();
  };

  const setMode = (graph_mode: GraphMode) => {
    onChange({
      ...config,
      graph_mode,
      url:
        graph_mode === 'domains' && config.url === 'https://quotes.toscrape.com'
          ? 'https://news.ycombinator.com'
          : graph_mode === 'pages' && config.url === 'https://news.ycombinator.com'
            ? 'https://quotes.toscrape.com'
            : config.url,
    });
  };

  const addExtraUrl = () => {
    onChange({ ...config, extra_urls: [...config.extra_urls, ''] });
  };

  const updateExtraUrl = (index: number, value: string) => {
    const next = [...config.extra_urls];
    next[index] = value;
    onChange({ ...config, extra_urls: next });
  };

  const removeExtraUrl = (index: number) => {
    onChange({
      ...config,
      extra_urls: config.extra_urls.filter((_, idx) => idx !== index),
    });
  };

  const handleIgnoredBlur = () => {
    const parsed = ignoredText
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    onChange({ ...config, ignored_domains: parsed });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadFile(file);
      e.target.value = '';
    }
  };

  const presets =
    config.graph_mode === 'domains'
      ? [
          'https://news.ycombinator.com',
          'https://lobste.rs',
          'https://en.wikipedia.org/wiki/Web_crawler',
        ]
      : ['https://quotes.toscrape.com', 'https://books.toscrape.com', 'https://example.com'];

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-slate-800/80 bg-slate-900/90 backdrop-blur-md">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-400 ring-1 ring-cyan-500/30">
            <Globe className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-slate-100">Web-Graph</h1>
            <p className="text-[11px] text-slate-400">BFS Link Crawler & Visualizer</p>
          </div>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>
          {badge.label}
        </span>
      </div>

      {/* Sidebar Tabs */}
      <div className="grid grid-cols-3 border-b border-slate-800 bg-slate-950/60 px-1.5 pt-2">
        <button
          type="button"
          onClick={() => setActiveTab('crawl')}
          className={`flex items-center justify-center gap-1 border-b-2 pb-2 text-[11px] font-medium transition ${
            activeTab === 'crawl'
              ? 'border-cyan-400 text-cyan-300'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Play className="h-3 w-3" />
          Crawl
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('ranking')}
          className={`flex items-center justify-center gap-1 border-b-2 pb-2 text-[11px] font-medium transition ${
            activeTab === 'ranking'
              ? 'border-cyan-400 text-cyan-300'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Trophy className="h-3 w-3" />
          Ranking
          {nodeCount > 0 && (
            <span className="rounded-full bg-slate-800 px-1.5 font-mono text-[10px] text-slate-300">
              {nodeCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('saved')}
          className={`flex items-center justify-center gap-1 border-b-2 pb-2 text-[11px] font-medium transition ${
            activeTab === 'saved'
              ? 'border-cyan-400 text-cyan-300'
              : 'border-transparent text-slate-400 hover:text-slate-200'
          }`}
        >
          <Database className="h-3 w-3" />
          Simpan
          {savedCrawls.length > 0 && (
            <span className="rounded-full bg-slate-800 px-1.5 font-mono text-[10px] text-slate-300">
              {savedCrawls.length}
            </span>
          )}
        </button>
      </div>

      {/* Hidden file input shared across tabs */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.gz,.json.gz,application/json,application/gzip"
        onChange={handleFileChange}
        className="hidden"
      />

      {activeTab === 'crawl' ? (
        <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-3.5 overflow-y-auto p-4">
          {/* Mode Switcher */}
          <div>
            <label className="mb-1.5 block text-[11px] font-medium text-slate-400">
              Mode Representasi Graph
            </label>
            <div className="grid grid-cols-2 gap-1 rounded-xl border border-slate-800 bg-slate-950/80 p-1">
              <button
                type="button"
                disabled={isRunning}
                onClick={() => setMode('domains')}
                className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition ${
                  config.graph_mode === 'domains'
                    ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Network className="h-3.5 w-3.5" />
                Antar Website
              </button>
              <button
                type="button"
                disabled={isRunning}
                onClick={() => setMode('pages')}
                className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium transition ${
                  config.graph_mode === 'pages'
                    ? 'bg-cyan-500/20 text-cyan-300 ring-1 ring-cyan-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <FileCode2 className="h-3.5 w-3.5" />
                Halaman
              </button>
            </div>
          </div>

          {/* Step 1: Seed URL(s) */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-slate-300">
                1. Input Link (Seed URL)
              </label>
              <button
                type="button"
                disabled={isRunning || config.extra_urls.length >= 4}
                onClick={addExtraUrl}
                className="flex items-center gap-0.5 text-[11px] text-cyan-400 transition hover:text-cyan-300 disabled:opacity-40"
                title="Tambah website pembanding"
              >
                <Plus className="h-3 w-3" />
                Multi-Seed
              </button>
            </div>

            <input
              type="text"
              required
              disabled={isRunning}
              placeholder="https://news.ycombinator.com"
              value={config.url}
              onChange={(e) => onChange({ ...config, url: e.target.value })}
              className="w-full rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none transition focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 disabled:opacity-60"
            />

            {config.extra_urls.map((extra, idx) => (
              <div key={idx} className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="text"
                  disabled={isRunning}
                  placeholder={`Seed URL #${idx + 2} (opsional)`}
                  value={extra}
                  onChange={(e) => updateExtraUrl(idx, e.target.value)}
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950/80 px-2.5 py-1.5 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-500"
                />
                <button
                  type="button"
                  disabled={isRunning}
                  onClick={() => removeExtraUrl(idx)}
                  className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}

            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={isRunning}
                  onClick={() => onChange({ ...config, url: preset })}
                  className="rounded border border-slate-800 bg-slate-950/60 px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:border-slate-700 hover:text-cyan-300 disabled:opacity-50"
                >
                  {preset.replace('https://', '').slice(0, 26)}
                </button>
              ))}
            </div>
          </div>

          {/* Step 2 & 3: Depth & Limits */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-slate-300">
              <Layers className="h-3.5 w-3.5 text-cyan-400" />
              <span>2. Kedalaman Loop (Depth = n)</span>
            </div>

            <div className="mb-3">
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                <label htmlFor="max-depth-input" className="text-slate-400">
                  Max Depth (n)
                </label>
                <input
                  id="max-depth-input"
                  type="number"
                  min={0}
                  step={1}
                  disabled={isRunning}
                  value={config.max_depth}
                  onChange={(e) => {
                    const parsed = Number.parseInt(e.target.value, 10);
                    onChange({
                      ...config,
                      max_depth: Number.isNaN(parsed) ? 0 : Math.max(0, parsed),
                    });
                  }}
                  className="w-20 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-right font-mono text-xs font-semibold text-cyan-300 outline-none focus:border-cyan-500 disabled:opacity-60"
                />
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {[1, 2, 3, 5, 10].map((presetDepth) => (
                  <button
                    key={presetDepth}
                    type="button"
                    disabled={isRunning}
                    onClick={() => onChange({ ...config, max_depth: presetDepth })}
                    className={`rounded border px-2 py-0.5 font-mono text-[10px] transition disabled:opacity-50 ${
                      config.max_depth === presetDepth
                        ? 'border-cyan-500/50 bg-cyan-500/20 text-cyan-300'
                        : 'border-slate-800 bg-slate-900 text-slate-400 hover:border-slate-700 hover:text-slate-200'
                    }`}
                  >
                    d={presetDepth}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                {config.graph_mode === 'domains'
                  ? config.max_depth === 0
                    ? 'Hanya memeriksa website awal (depth 0).'
                    : `Melompat antar-website lain hingga ${config.max_depth} tingkat relasi.`
                  : config.max_depth === 0
                    ? 'Hanya memeriksa halaman awal (depth 0).'
                    : `Menelusuri link halaman hingga ${config.max_depth} tingkat.`}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="mb-1 block text-[11px] text-slate-400">Max Total Fetch</label>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  disabled={isRunning}
                  value={config.max_pages}
                  onChange={(e) =>
                    onChange({ ...config, max_pages: Math.max(1, Number(e.target.value) || 1) })
                  }
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500"
                />
              </div>

              {config.graph_mode === 'domains' ? (
                <div>
                  <label
                    className="mb-1 block text-[11px] text-slate-400"
                    title="Maksimal halaman yang disampling per website untuk mencari link keluar"
                  >
                    Halaman / Website
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    disabled={isRunning}
                    value={config.max_pages_per_domain}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        max_pages_per_domain: Math.min(10, Math.max(1, Number(e.target.value) || 1)),
                      })
                    }
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500"
                  />
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-[11px] text-slate-400">Concurrency</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    disabled={isRunning}
                    value={config.concurrency}
                    onChange={(e) =>
                      onChange({
                        ...config,
                        concurrency: Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                      })
                    }
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Mode-specific Filters */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <div className="mb-2.5 flex items-center gap-1.5 text-xs font-medium text-slate-300">
              <SlidersHorizontal className="h-3.5 w-3.5 text-cyan-400" />
              <span>
                {config.graph_mode === 'domains'
                  ? '3. Filter Ekosistem Website'
                  : '3. Cakupan Crawling'}
              </span>
            </div>

            {config.graph_mode === 'domains' ? (
              <>
                <label className="mb-2.5 flex cursor-pointer items-center justify-between gap-2 text-xs text-slate-300">
                  <span>Sembunyikan sosmed & tracker</span>
                  <input
                    type="checkbox"
                    disabled={isRunning}
                    checked={config.exclude_common_platforms}
                    onChange={(e) =>
                      onChange({ ...config, exclude_common_platforms: e.target.checked })
                    }
                    className="h-4 w-4 rounded border-slate-700 accent-cyan-500"
                  />
                </label>

                <div className="mb-2.5">
                  <label className="mb-1 block text-[11px] text-slate-400">
                    Abaikan Domain (pisahkan koma)
                  </label>
                  <input
                    type="text"
                    disabled={isRunning}
                    placeholder="contoh: github.com, medium.com"
                    value={ignoredText}
                    onChange={(e) => setIgnoredText(e.target.value)}
                    onBlur={handleIgnoredBlur}
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-500"
                  />
                </div>
              </>
            ) : (
              <>
                <select
                  disabled={isRunning}
                  value={config.scope}
                  onChange={(e) => onChange({ ...config, scope: e.target.value as CrawlScope })}
                  className="mb-3 w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-cyan-500"
                >
                  <option value="internal">Internal Only (Same Host)</option>
                  <option value="subdomains">Include Subdomains</option>
                  <option value="all">Cross-Domain (All Links)</option>
                </select>

                <label className="mb-2 flex cursor-pointer items-center justify-between gap-2 text-xs text-slate-300">
                  <span>Tampilkan link eksternal (leaf)</span>
                  <input
                    type="checkbox"
                    disabled={isRunning}
                    checked={config.include_external_leaves}
                    onChange={(e) =>
                      onChange({ ...config, include_external_leaves: e.target.checked })
                    }
                    className="h-4 w-4 rounded border-slate-700 accent-cyan-500"
                  />
                </label>
              </>
            )}

            <label className="flex cursor-pointer items-center justify-between gap-2 text-xs text-slate-300">
              <span className="flex items-center gap-1">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                Patuhi robots.txt
              </span>
              <input
                type="checkbox"
                disabled={isRunning}
                checked={config.respect_robots}
                onChange={(e) => onChange({ ...config, respect_robots: e.target.checked })}
                className="h-4 w-4 rounded border-slate-700 accent-cyan-500"
              />
            </label>
          </div>

          {errorMessage && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              {errorMessage}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-2">
            {!isRunning ? (
              <button
                type="submit"
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-cyan-500 px-3 py-2.5 text-xs font-semibold text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:bg-cyan-400 active:scale-[0.99]"
              >
                <Play className="h-3.5 w-3.5 fill-current" />
                Mulai Crawl
              </button>
            ) : (
              <button
                type="button"
                onClick={onStop}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-rose-500 px-3 py-2.5 text-xs font-semibold text-white shadow-lg shadow-rose-500/20 transition hover:bg-rose-400"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
                Hentikan
              </button>
            )}
            <button
              type="button"
              disabled={isRunning}
              onClick={() => fileInputRef.current?.click()}
              title="Upload file graph (.json / .json.gz)"
              className="flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-2.5 text-slate-300 transition hover:bg-slate-800 hover:text-cyan-300 disabled:opacity-40"
            >
              <Upload className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={isRunning || nodeCount === 0}
              onClick={onReset}
              title="Reset Graph"
              className="flex items-center justify-center rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-2.5 text-slate-300 transition hover:bg-slate-800 hover:text-white disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Live Telemetry */}
          <div className="mt-auto grid grid-cols-3 gap-2 border-t border-slate-800 pt-3">
            <div className="rounded-lg bg-slate-950/70 p-2 text-center">
              <div className="font-mono text-sm font-semibold text-slate-100">
                {summary?.pages_crawled ?? 0}
              </div>
              <div className="text-[10px] text-slate-400">Fetched</div>
            </div>
            <div className="rounded-lg bg-slate-950/70 p-2 text-center">
              <div className="font-mono text-sm font-semibold text-cyan-300">{nodeCount}</div>
              <div className="text-[10px] text-slate-400">
                {config.graph_mode === 'domains' ? 'Websites' : 'Nodes'}
              </div>
            </div>
            <div className="rounded-lg bg-slate-950/70 p-2 text-center">
              <div className="font-mono text-sm font-semibold text-indigo-300">{edgeCount}</div>
              <div className="text-[10px] text-slate-400">Relasi</div>
            </div>
          </div>
        </form>
      ) : activeTab === 'ranking' ? (
        <RankingPanel
          nodes={nodes}
          graphMode={activeGraphMode}
          pageRankScores={pageRankScores}
          rankPositions={rankPositions}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
        />
      ) : (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
          {/* Upload Dropzone */}
          <button
            type="button"
            disabled={isRunning}
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-cyan-500/40 bg-cyan-500/5 px-3 py-4 text-center transition hover:border-cyan-400 hover:bg-cyan-500/10 disabled:opacity-40"
          >
            <Upload className="h-5 w-5 text-cyan-400" />
            <span className="text-xs font-medium text-slate-200">
              Upload File Graph (.json / .json.gz)
            </span>
            <span className="text-[10px] text-slate-400">
              Langsung visualisasi tanpa crawl ulang (bisa juga drag & drop ke area graph)
            </span>
          </button>

          <div className="flex items-center justify-between text-[11px] font-medium text-slate-400">
            <span>Riwayat Auto-Save (Zlib SQLite)</span>
            <span className="font-mono text-slate-500">{savedCrawls.length}</span>
          </div>

          {savedCrawls.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-center text-xs text-slate-500">
              Belum ada hasil crawl tersimpan. Setiap crawl yang selesai otomatis tersimpan terkompresi di sini.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {savedCrawls.map((item) => (
                <li
                  key={item.job_id}
                  className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5 transition hover:border-slate-700"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-slate-200" title={item.seed_url}>
                      {item.seed_url.replace(/^https?:\/\//, '')}
                    </span>
                    <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">
                      {item.graph_mode === 'domains' ? 'Web' : 'Page'}
                    </span>
                  </div>
                  <div className="mb-2 flex items-center gap-2 text-[10px] text-slate-400">
                    <span>{item.nodes_count} node</span>
                    <span>•</span>
                    <span>{item.edges_count} relasi</span>
                    <span>•</span>
                    <span className="font-mono text-emerald-400">
                      {formatBytes(item.compressed_bytes)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={isRunning}
                      onClick={() => onLoadSaved(item.job_id)}
                      className="flex flex-1 items-center justify-center gap-1 rounded-md bg-cyan-500/15 px-2 py-1 text-[11px] font-medium text-cyan-300 transition hover:bg-cyan-500/25 disabled:opacity-40"
                    >
                      <FolderOpen className="h-3 w-3" />
                      Buka Graph
                    </button>
                    <a
                      href={`/api/saved/${item.job_id}/download?fmt=gz`}
                      className="flex items-center gap-1 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-[11px] text-slate-300 transition hover:border-slate-700 hover:text-white"
                      title="Unduh file terkompresi (.json.gz) untuk di-upload ulang"
                    >
                      <Download className="h-3 w-3" />
                      .gz
                    </a>
                    <button
                      type="button"
                      onClick={() => onDeleteSaved(item.job_id)}
                      className="rounded-md border border-slate-800 bg-slate-900 p-1 text-slate-400 transition hover:border-rose-500/40 hover:text-rose-400"
                      title="Hapus"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
};

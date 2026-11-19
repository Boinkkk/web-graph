export type CrawlScope = 'internal' | 'subdomains' | 'all';
export type GraphMode = 'domains' | 'pages';
export type JobStatus = 'idle' | 'running' | 'completed' | 'stopped' | 'failed';
export type ColorMode = 'depth' | 'status' | 'domain' | 'tld';
export type SizeMode = 'in_degree' | 'pagerank' | 'uniform';
export type CenterMode = 'seed' | 'pagerank';

export interface CrawlConfig {
  url: string;
  extra_urls: string[];
  graph_mode: GraphMode;
  max_depth: number;
  max_pages: number;
  max_pages_per_domain: number;
  scope: CrawlScope;
  include_external_leaves: boolean;
  exclude_common_platforms: boolean;
  ignored_domains: string[];
  concurrency: number;
  respect_robots: boolean;
}

export interface GraphNode {
  id: string;
  url: string;
  label: string;
  domain: string;
  depth: number;
  status_code: number | null;
  content_type: string | null;
  error: string | null;
  is_external: boolean;
  crawled: boolean;
  pages_sampled: number;
  in_degree: number;
  out_degree: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
}

export interface EdgeSample {
  from_url: string;
  to_url: string;
}

export interface GraphEdge {
  source: string | GraphNode;
  target: string | GraphNode;
  weight: number;
  samples: EdgeSample[];
}

export interface CrawlJobSummary {
  job_id: string;
  status: Exclude<JobStatus, 'idle'>;
  graph_mode: GraphMode;
  seed_url: string;
  max_depth: number;
  max_pages: number;
  pages_crawled: number;
  nodes_count: number;
  edges_count: number;
  error: string | null;
}

export interface CrawlSnapshot {
  summary: CrawlJobSummary;
  nodes: GraphNode[];
  links: Array<{
    source: string;
    target: string;
    weight?: number;
    samples?: EdgeSample[];
  }>;
}

export interface SavedCrawlMeta {
  job_id: string;
  seed_url: string;
  graph_mode: GraphMode;
  status: Exclude<JobStatus, 'idle'>;
  max_depth: number;
  pages_crawled: number;
  nodes_count: number;
  edges_count: number;
  compressed_bytes: number;
  created_at: string;
}

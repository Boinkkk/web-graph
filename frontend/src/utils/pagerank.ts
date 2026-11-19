import type { GraphEdge, GraphNode } from '../types/graph';

function getEndpointId(endpoint: string | GraphNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

/**
 * Compute weighted PageRank scores for all nodes in the graph using power iteration.
 * Dangling nodes (zero out-weight) redistribute their rank evenly across all nodes.
 */
export function computePageRank(
  nodes: GraphNode[],
  links: GraphEdge[],
  damping = 0.85,
  maxIterations = 40,
  tolerance = 1e-6
): Map<string, number> {
  const scores = new Map<string, number>();
  const n = nodes.length;
  if (n === 0) return scores;

  const indexById = new Map<string, number>();
  nodes.forEach((node, idx) => {
    indexById.set(node.id, idx);
  });

  // Build weighted adjacency list
  const outEdges: Array<Array<{ targetIdx: number; weight: number }>> = Array.from(
    { length: n },
    () => []
  );
  const outWeight = new Float64Array(n);

  for (const edge of links) {
    const srcIdx = indexById.get(getEndpointId(edge.source));
    const dstIdx = indexById.get(getEndpointId(edge.target));
    if (srcIdx === undefined || dstIdx === undefined || srcIdx === dstIdx) continue;

    const w = Math.max(1, edge.weight ?? 1);
    outEdges[srcIdx].push({ targetIdx: dstIdx, weight: w });
    outWeight[srcIdx] += w;
  }

  let ranks = new Float64Array(n).fill(1 / n);
  let nextRanks = new Float64Array(n);

  for (let iter = 0; iter < maxIterations; iter += 1) {
    let danglingSum = 0;
    for (let i = 0; i < n; i += 1) {
      if (outWeight[i] === 0) {
        danglingSum += ranks[i];
      }
    }

    const base = (1 - damping) / n + (damping * danglingSum) / n;
    nextRanks.fill(base);

    for (let i = 0; i < n; i += 1) {
      const totalW = outWeight[i];
      if (totalW === 0) continue;
      const share = (damping * ranks[i]) / totalW;
      for (const { targetIdx, weight } of outEdges[i]) {
        nextRanks[targetIdx] += share * weight;
      }
    }

    let diff = 0;
    for (let i = 0; i < n; i += 1) {
      diff += Math.abs(nextRanks[i] - ranks[i]);
    }

    const temp = ranks;
    ranks = nextRanks;
    nextRanks = temp;

    if (diff < tolerance) break;
  }

  nodes.forEach((node, idx) => {
    scores.set(node.id, ranks[idx]);
  });

  return scores;
}

/**
 * Convert PageRank score map into 1-based rank positions (1 = highest PageRank).
 */
export function computePageRankPositions(scores: Map<string, number>): Map<string, number> {
  const sorted = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  const positions = new Map<string, number>();
  sorted.forEach(([id], idx) => {
    positions.set(id, idx + 1);
  });
  return positions;
}

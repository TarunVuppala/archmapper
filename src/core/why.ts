// Why-path: shortest evidence-backed paths between two nodes.

import type { GraphEdge, EdgeKind, WhyPath, WhyPathStep } from './types.js';
import type { GraphStore } from './store.js';

const RELATIONAL: EdgeKind[] = [
  'CALLS', 'IMPORTS', 'EXPOSES', 'CONSUMES', 'READS', 'WRITES',
  'PUBLISHES', 'SUBSCRIBES', 'TESTS', 'DEPENDS_ON', 'IMPLEMENTS',
  'DOCUMENTS', 'USES_CONFIG',
];

export interface WhyPathOptions {
  maxPaths?: number;
  maxDepth?: number;
}

export function findWhyPaths(
  store: GraphStore,
  fromId: string,
  toId: string,
  options: WhyPathOptions = {}
): WhyPath[] {
  const maxPaths = options.maxPaths ?? 7;
  const maxDepth = options.maxDepth ?? 5;
  if (fromId === toId) return [];

  const from = store.resolveNode(fromId);
  const to = store.resolveNode(toId);
  if (!from || !to) return [];

  const paths: WhyPath[] = [];
  const queue: Array<{ id: string; steps: WhyPathStep[]; used: Set<string> }> = [
    { id: from.id, steps: [], used: new Set() },
  ];
  const seenAt = new Map<string, number>();
  seenAt.set(from.id, 0);

  while (queue.length > 0 && paths.length < maxPaths) {
    const cur = queue.shift()!;
    if (cur.steps.length >= maxDepth) continue;

    const neighbors = relevantNeighbors(store, cur.id);
    for (const { edge, next } of neighbors) {
      if (next === cur.id) continue;
      if (cur.used.has(edge.id)) continue;
      const depth = cur.steps.length + 1;
      const prev = seenAt.get(next);
      // Allow a node to be reached a few extra times so we can collect alternate paths.
      if (prev !== undefined && depth > prev + 2) continue;
      if (prev === undefined) seenAt.set(next, depth);

      const step: WhyPathStep = {
        from: edge.from,
        to: edge.to,
        edgeType: edge.type,
        evidence: edge.evidence[0],
      };
      const steps = [...cur.steps, step];
      const used = new Set(cur.used);
      used.add(edge.id);

      if (next === to.id) {
        paths.push({
          steps,
          evidence: steps.flatMap(s => (s.evidence ? [s.evidence] : [])),
        });
        if (paths.length >= maxPaths) break;
        continue;
      }

      queue.push({ id: next, steps, used });
    }
  }

  return paths;
}

function relevantNeighbors(
  store: GraphStore,
  nodeId: string
): Array<{ edge: GraphEdge; next: string }> {
  const out = store.getOutEdges(nodeId).filter(e => RELATIONAL.includes(e.type));
  const inn = store.getInEdges(nodeId).filter(e => RELATIONAL.includes(e.type));
  const result: Array<{ edge: GraphEdge; next: string }> = [];
  for (const e of out) result.push({ edge: e, next: e.to });
  for (const e of inn) result.push({ edge: e, next: e.from });
  return result;
}

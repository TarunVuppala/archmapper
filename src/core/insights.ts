// Architecture insights over the ONE graph.
// Cycles, coupling, bottlenecks, hubs, isolated modules, hotspots, large downstream impact.

import type {
  EdgeKind,
  GraphNode,
  InsightItem,
  InsightsResult,
  CycleInsight,
} from './types.js';
import type { GraphStore } from './store.js';
import { computeImpact } from './impact.js';

const STRUCTURAL: EdgeKind[] = ['CALLS', 'IMPORTS', 'DEPENDS_ON', 'CONSUMES', 'EXPOSES'];
const SKIP_KINDS = new Set(['File', 'Repo', 'Doc', 'External', 'Interface', 'Column', 'ConfigKey']);

export function computeInsights(store: GraphStore, limit = 8): InsightsResult {
  const nodes = store.listAllNodes().filter(n => !SKIP_KINDS.has(n.kind));
  const degree = new Map<string, { in: number; out: number; total: number }>();

  for (const n of nodes) {
    const out = store.getOutEdges(n.id).filter(e => STRUCTURAL.includes(e.type));
    const inn = store.getInEdges(n.id).filter(e => STRUCTURAL.includes(e.type));
    degree.set(n.id, { in: inn.length, out: out.length, total: inn.length + out.length });
  }

  const scored = nodes
    .map(n => ({ node: n, deg: degree.get(n.id)! }))
    .filter(x => x.deg.total > 0 || nIsSymbol(x.node));

  const highlyCoupled = scored
    .filter(x => x.deg.total >= 4)
    .sort((a, b) => b.deg.total - a.deg.total)
    .slice(0, limit)
    .map(x => item(x.node, x.deg.total, `${x.deg.in} inbound, ${x.deg.out} outbound relationships`));

  const bottlenecks = scored
    .filter(x => x.deg.in >= 2 && x.deg.out >= 2)
    .sort((a, b) => (b.deg.in * b.deg.out) - (a.deg.in * a.deg.out))
    .slice(0, limit)
    .map(x => item(x.node, x.deg.in * x.deg.out, `On ${x.deg.in} inbound and ${x.deg.out} outbound paths`));

  const hubs = scored
    .sort((a, b) => b.deg.total - a.deg.total)
    .slice(0, limit)
    .map(x => item(x.node, x.deg.total, `${x.deg.total} connections`));

  const isolated = nodes
    .filter(n => nIsSymbol(n))
    .filter(n => (degree.get(n.id)?.total ?? 0) === 0)
    .slice(0, limit)
    .map(n => item(n, 0, 'No calls, imports, or API relationships found'));

  const hotspots: InsightItem[] = [];
  const largeDownstream: InsightItem[] = [];
  const candidates = scored
    .filter(x => nIsSymbol(x.node) || x.node.kind === 'API' || x.node.kind === 'Service' || x.node.kind === 'Table')
    .sort((a, b) => b.deg.total - a.deg.total)
    .slice(0, 20);

  for (const c of candidates) {
    const impact = computeImpact(store, [c.node.id], { direction: 'downstream', maxDepth: 4, maxPaths: 3 });
    const downstream = Math.max(0, impact.nodes.length - 1);
    if (downstream >= 3) {
      largeDownstream.push(item(
        c.node,
        downstream,
        `Changing this may affect ${downstream} other components`
      ));
    }
    if (downstream >= 5 || (c.deg.total >= 6 && downstream >= 2)) {
      hotspots.push(item(
        c.node,
        downstream + c.deg.total,
        `High connectivity (${c.deg.total}) and ${downstream} downstream effects`
      ));
    }
  }

  largeDownstream.sort((a, b) => b.score - a.score);
  hotspots.sort((a, b) => b.score - a.score);

  return {
    ok: true,
    cycles: findCycles(store, nodes, 12),
    highlyCoupled,
    bottlenecks,
    hubs,
    isolated,
    hotspots: hotspots.slice(0, limit),
    largeDownstream: largeDownstream.slice(0, limit),
  };
}

function nIsSymbol(n: GraphNode): boolean {
  return n.kind === 'Function' || n.kind === 'Method' || n.kind === 'Class' || n.kind === 'Module';
}

function item(node: GraphNode, score: number, reason: string): InsightItem {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    score,
    reason,
    path: node.path,
  };
}

function findCycles(store: GraphStore, nodes: GraphNode[], limit: number): CycleInsight[] {
  const cycles: CycleInsight[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const interesting = nodes.filter(n =>
    n.kind === 'Function' || n.kind === 'Method' || n.kind === 'Module' || n.kind === 'File' || n.kind === 'Class' || n.kind === 'Package'
  );

  function dfs(id: string): void {
    if (cycles.length >= limit) return;
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);

    const outs = store.getOutEdges(id).filter(e => e.type === 'CALLS' || e.type === 'IMPORTS' || e.type === 'DEPENDS_ON');
    for (const e of outs) {
      if (visiting.has(e.to)) {
        const idx = stack.indexOf(e.to);
        if (idx >= 0) {
          const loop = [...stack.slice(idx), e.to];
          if (loop.length >= 3) {
            cycles.push({
              nodes: loop,
              edgeTypes: [e.type],
            });
          }
        }
      } else if (!visited.has(e.to)) {
        dfs(e.to);
      }
      if (cycles.length >= limit) return;
    }

    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const n of interesting) {
    if (!visited.has(n.id)) dfs(n.id);
    if (cycles.length >= limit) break;
  }

  return cycles;
}

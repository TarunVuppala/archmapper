// Graph projections of the ONE graph. Filters only — never a second store.

import type { EdgeKind, GraphEdge, GraphNode, GraphView, NodeKind, ViewMode } from './types.js';
import type { GraphStore } from './store.js';

const HEIGHT_KINDS: NodeKind[] = [
  'Function', 'Method', 'Class', 'Interface', 'Module', 'Package',
  'API', 'Route', 'Table', 'External', 'Service', 'Repo',
  'Event', 'Job', 'Contract', 'Test', 'Infra', 'Doc',
];

const DEPTH_KINDS: NodeKind[] = [
  'Service', 'Package', 'Class', 'Interface', 'Function', 'Method',
  'API', 'Table', 'Test', 'Event',
];

const CALL_KINDS: NodeKind[] = ['Function', 'Method', 'Class'];
const API_KINDS: NodeKind[] = ['API', 'Route', 'Service', 'External', 'Contract'];
const DB_KINDS: NodeKind[] = ['Table', 'Column', 'Function', 'Method', 'Job'];

const HEIGHT_EDGES: EdgeKind[] = [
  'DEPENDS_ON', 'EXPOSES', 'CONSUMES', 'READS', 'WRITES',
  'PUBLISHES', 'SUBSCRIBES', 'CONTAINS',
];
const CALL_EDGES: EdgeKind[] = ['CALLS', 'IMPLEMENTS'];
const API_EDGES: EdgeKind[] = ['EXPOSES', 'CONSUMES', 'DEPENDS_ON'];
const DB_EDGES: EdgeKind[] = ['READS', 'WRITES', 'CONTAINS'];

export function projectView(
  store: GraphStore,
  mode: ViewMode = 'height',
  focusId?: string,
  maxNodes = 250
): GraphView {
  if (mode === 'depth' && focusId) {
    return depthFrom(store, focusId, maxNodes);
  }
  if (mode === 'flow' && focusId) {
    return depthFrom(store, focusId, maxNodes);
  }

  const kinds =
    mode === 'height' ? HEIGHT_KINDS :
    mode === 'call' ? CALL_KINDS :
    mode === 'api' ? API_KINDS :
    mode === 'db' ? DB_KINDS :
    DEPTH_KINDS;

  const edgeTypes =
    mode === 'height' ? HEIGHT_EDGES :
    mode === 'call' ? CALL_EDGES :
    mode === 'api' ? API_EDGES :
    mode === 'db' ? DB_EDGES :
    undefined;

  let nodes = store.listNodesByKinds(kinds, maxNodes);

  // Height view must not become a file hairball. If we have almost nothing
  // at the service/API layer, fall back to classes + APIs + tables.
  // If very few high-level nodes, include code-level symbols too
  if (nodes.length < 5) {
    nodes = store.listNodesByKinds(
      ['Function', 'Method', 'Class', 'Interface', 'Module', 'Package',
       'API', 'Route', 'Table', 'External', 'Service', 'Repo',
       'Event', 'Job', 'Contract', 'Test'],
      Math.min(200, maxNodes)
    );
  }

  const ids = new Set(nodes.map(n => n.id));
  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    for (const e of store.getOutEdges(n.id)) {
      if (!ids.has(e.to)) continue;
      if (edgeTypes && !edgeTypes.includes(e.type)) continue;
      edges.push(e);
    }
  }

  return { mode, focusId, nodes, edges };
}

function depthFrom(store: GraphStore, focusId: string, maxNodes: number): GraphView {
  const start = store.resolveNode(focusId);
  if (!start) return { mode: 'depth', focusId, nodes: [], edges: [] };

  const nodes: GraphNode[] = [start];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>([start.id]);
  const queue = [start.id];

  while (queue.length > 0 && nodes.length < maxNodes) {
    const id = queue.shift()!;
    const neighbors = [...store.getOutEdges(id), ...store.getInEdges(id)];
    for (const e of neighbors) {
      const other = e.from === id ? e.to : e.from;
      if (e.type === 'CONTAINS' && store.getNode(other)?.kind === 'File' && other !== start.id) {
        continue;
      }
      if (!seen.has(e.id)) {
        edges.push(e);
      }
      if (seen.has(other)) continue;
      const node = store.getNode(other);
      if (!node) continue;
      seen.add(other);
      nodes.push(node);
      queue.push(other);
    }
  }

  const ids = new Set(nodes.map(n => n.id));
  return {
    mode: 'depth',
    focusId: start.id,
    nodes,
    edges: edges.filter(e => ids.has(e.from) && ids.has(e.to)),
  };
}

export function mermaidFromView(view: GraphView): string {
  const lines = ['graph LR'];
  const idOf = (id: string) => id.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 48);
  const names = new Map(view.nodes.map(n => [n.id, n.name]));
  for (const e of view.edges.slice(0, 200)) {
    const a = names.get(e.from) ?? e.from;
    const b = names.get(e.to) ?? e.to;
    lines.push(`  ${idOf(e.from)}["${esc(a)}"] -->|${e.type}| ${idOf(e.to)}["${esc(b)}"]`);
  }
  if (lines.length === 1) {
    for (const n of view.nodes.slice(0, 40)) {
      lines.push(`  ${idOf(n.id)}["${esc(n.name)}"]`);
    }
  }
  return lines.join('\n');
}

function esc(s: string): string {
  return s.replace(/"/g, "'").slice(0, 40);
}

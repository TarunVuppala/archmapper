// Impact / blast-radius algorithm.
// BFS on the one graph with edge-type filtering, why-path extraction, risk chips.

import type {
  GraphNode,
  GraphEdge,
  EdgeKind,
  WhyPath,
  WhyPathStep,
  RiskChip,
  RiskKind,
  ImpactResult,
} from './types.js';
import type { GraphStore } from './store.js';

// Edge types used for downstream traversal (who calls/uses this?)
const DOWNSTREAM_EDGE_TYPES: EdgeKind[] = [
  'CALLS', 'EXPOSES', 'CONSUMES', 'WRITES', 'PUBLISHES',
  'TESTS', 'DEPENDS_ON', 'SUBSCRIBES', 'DOCUMENTS',
];

// Edge types used for upstream traversal (what does this depend on?)
const UPSTREAM_EDGE_TYPES: EdgeKind[] = [
  'CALLS', 'IMPORTS', 'READS', 'CONSUMES', 'DEPENDS_ON',
];

// For downstream, we traverse REVERSED edges — i.e. who has an edge TO us?
// A CALLS edge from A→B means B is called by A (downstream of B).
// So downstream of B means we follow incoming CALLS edges.

// In our DB, edges are stored as (from, to) with direction in the edge type.
// For impact analysis, we want:
//   downstream(start): find all nodes reachable by following edges that point TO start
//     - incoming CALLS edges (who calls me?)
//     - incoming EXPOSES edges? No — outgoing EXPOSES from me means I expose an API
//     - incoming CONSUMES edges? No — outgoing CONSUMES means I consume an API
//
// Actually let's think about this differently:
//
// If I change processPayment(), what's affected downstream?
//   - callers of processPayment() (nodes with CALLS edge to processPayment)
//   - APIs that expose processPayment (nodes with EXPOSES edge from processPayment)
//   - consumers of those APIs
//   - tables that processPayment writes to
//   - events that processPayment publishes
//   - tests that test processPayment
//   - packages that depend on the package containing processPayment
//
// So downstream of processPayment:
//   - Find all edges FROM processPayment: EXPOSES → API, WRITES → Table, PUBLISHES → Event, TESTS → Test
//   - Then from each of those, continue traversal:
//     - From API: find CONSUMES → nodes
//     - From Table: no further traversal typically
//     - From Event: find SUBSCRIBES → nodes
//     - From Test: maybe test coverage
//   - Also find edges TO processPayment: CALLS ← nodes
//     - Then from those callers, continue: what else calls them? (transitive callers)
//
// For upstream of processPayment:
//   - Find all edges FROM processPayment: CALLS → function, IMPORTS → module, READS → table
//   - Transitively continue

export interface ImpactOptions {
  direction?: 'downstream' | 'upstream';
  maxDepth?: number;
  maxPaths?: number;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_PATHS = 7;

export function computeImpact(
  store: GraphStore,
  startIds: string[],
  options: ImpactOptions = {}
): ImpactResult {
  const direction = options.direction ?? 'downstream';
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;

  const visited = new Set<string>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const paths: WhyPath[] = [];
  const testsToRun: string[] = [];
  const riskChips: RiskChip[] = [];
  const counts: Record<string, number> = {};
  const docsForExternals: string[] = [];

  // BFS queue: [nodeId, depth, pathSoFar]
  const queue: [string, number, WhyPathStep[]][] = [];

  for (const id of startIds) {
    const node = store.getNode(id);
    if (node) {
      queue.push([id, 0, []]);
    }
  }

  while (queue.length > 0) {
    const [currentId, depth, pathSoFar] = queue.shift()!;

    if (visited.has(currentId)) continue;
    if (depth > maxDepth) continue;

    visited.add(currentId);
    const currentNode = store.getNode(currentId);
    if (currentNode) {
      nodes.push(currentNode);
      counts[currentNode.kind] = (counts[currentNode.kind] || 0) + 1;

      // Collect tests
      if (currentNode.kind === 'Test') {
        testsToRun.push(currentNode.id);
      }

      // Collect externals for docs
      if (currentNode.kind === 'External') {
        docsForExternals.push(currentNode.id);
      }

      // Risk: critical nodes
      if (currentNode.tags?.includes('critical')) {
        riskChips.push({
          kind: 'critical',
          message: `Critical node on impact path: ${currentNode.name}`,
          nodeId: currentNode.id,
        });
      }
    }

    // Get relevant edges based on direction
    const outgoing = store.getOutEdges(currentId);
    const incoming = store.getInEdges(currentId);

    let relevantEdges: GraphEdge[];

    if (direction === 'downstream') {
      // Downstream: what is affected if this node changes?
      // Outgoing: things this node exposes, writes to, publishes to, calls
      // Incoming: callers of this node, consumers of this node
      relevantEdges = [
        ...outgoing.filter(e =>
          ['CALLS', 'EXPOSES', 'WRITES', 'PUBLISHES', 'TESTS', 'DEPENDS_ON'].includes(e.type)
        ),
        ...incoming.filter(e =>
          ['CALLS', 'CONSUMES', 'SUBSCRIBES'].includes(e.type)
        ),
      ];
    } else {
      // Upstream: what does this node depend on?
      // Outgoing: CALLS→func, IMPORTS→module, READS→table, CONSUMES→api
      // Incoming: callers of this node (who depends on me? — also upstream context)
      relevantEdges = outgoing.filter(e =>
        ['CALLS', 'IMPORTS', 'READS', 'CONSUMES', 'DEPENDS_ON'].includes(e.type)
      );
    }

    for (const edge of relevantEdges) {
      edges.push(edge);

      // Determine next node to traverse
      const nextId = direction === 'downstream'
        ? (edge.to === currentId ? edge.from : edge.to)
        : edge.to;

      if (nextId === currentId || visited.has(nextId)) continue;

      const step: WhyPathStep = {
        from: edge.from === currentId ? edge.from : nextId,
        to: edge.to === currentId ? edge.to : nextId,
        edgeType: edge.type,
        evidence: edge.evidence[0],
      };

      queue.push([nextId, depth + 1, [...pathSoFar, step]]);

      // Risk: DB writes
      if (edge.type === 'WRITES') {
        riskChips.push({
          kind: 'db_write',
          message: `DB write detected: ${edge.from} → ${edge.to}`,
          nodeId: edge.to,
        });
      }

      // Risk: external dependencies
      const targetNode = store.getNode(nextId);
      if (targetNode?.kind === 'External') {
        riskChips.push({
          kind: 'external',
          message: `External dependency: ${targetNode.name}`,
          nodeId: nextId,
        });
      }

      // Risk: conflict edges
      if (edge.conflict) {
        riskChips.push({
        kind: 'conflict',
        message: `Conflicting evidence on edge ${edge.id}`,
        });
      }
    }
  }

  // Generate why-paths (up to maxPaths)
  // Find paths from start to the most important terminal nodes
  const terminalKinds = new Set(['Table', 'API', 'External', 'Service', 'Event']);
  const terminalNodes = nodes.filter(n => terminalKinds.has(n.kind));

  for (const terminal of terminalNodes.slice(0, maxPaths)) {
    const path = reconstructPath(store, startIds[0], terminal.id, direction);
    if (path) {
      paths.push(path);
    }
  }

  // If no paths found from start, at least create a single-step path
  if (paths.length === 0 && startIds.length > 0 && nodes.length > 1) {
    const significant = nodes.find(n =>
      n.kind !== 'File' && n.kind !== 'Module' && !startIds.includes(n.id)
    );
    if (significant && edges.length > 0) {
      const edge = edges[0];
      paths.push({
        steps: [{
          from: edge.from,
          to: edge.to,
          edgeType: edge.type,
          evidence: edge.evidence[0],
        }],
        evidence: edge.evidence,
      });
    }
  }

  // Unchecked risk for nodes with no test
  const functionNodes = nodes.filter(n =>
    n.kind === 'Function' || n.kind === 'Method'
  );
  const testedIds = new Set(testsToRun);
  // Simple heuristic: check if any TESTS edge points to function nodes
  for (const fn of functionNodes) {
    const testEdges = store.getInEdges(fn.id).filter(e => e.type === 'TESTS');
    if (testEdges.length === 0) {
      riskChips.push({
        kind: 'untested',
        message: `No tests found for ${fn.name}`,
        nodeId: fn.id,
      });
    }
  }

  return {
    ok: true,
    startIds,
    direction,
    counts: counts as Record<import('./types.js').NodeKind, number>,
    nodes,
    edges,
    paths,
    testsToRun,
    riskChips,
    docsForExternals,
    suggestedReviewers: [],
  };
}

// ─── Path Reconstruction ──────────────────────────────────────────────────────

function reconstructPath(
  store: GraphStore,
  fromId: string,
  toId: string,
  direction: 'downstream' | 'upstream'
): WhyPath | undefined {
  // BFS to find shortest path
  const visited = new Map<string, string>(); // child → parent
  const queue: string[] = [fromId];
  visited.set(fromId, '');

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toId) {
      // Reconstruct path
      const steps: WhyPathStep[] = [];
      let currentId = toId;
      while (currentId !== fromId) {
        const parentId = visited.get(currentId)!;
        const edge = store.getOutEdges(parentId).find(e => e.to === currentId)
          ?? store.getInEdges(currentId).find(e => e.from === parentId);
        if (edge) {
          steps.unshift({
            from: edge.from,
            to: edge.to,
            edgeType: edge.type,
            evidence: edge.evidence[0],
          });
        }
        currentId = parentId;
      }
      return {
        steps,
        evidence: steps.flatMap(s => (s.evidence ? [s.evidence] : [])),
      };
    }

    // Traverse neighbors
    const outgoing = store.getOutEdges(current);
    const incoming = store.getInEdges(current);
    const neighbors = [...outgoing, ...incoming];

    for (const edge of neighbors) {
      const next = edge.from === current ? edge.to : edge.from;
      if (!visited.has(next)) {
        visited.set(next, current);
        queue.push(next);
      }
    }
  }

  return undefined;
}

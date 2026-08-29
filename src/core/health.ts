// Health — graph consistency and inference health checks.

import type { HealthRow } from './types.js';
import type { GraphStore } from './store.js';

export function healthCheck(store: GraphStore): HealthRow[] {
  const rows: HealthRow[] = [];

  // Node count
  rows.push({
    category: 'graph',
    status: 'ok',
    message: `${store.nodeCount} nodes, ${store.edgeCount} edges`,
  });

  // Validation
  const validation = store.validateGraph();
  if (!validation.ok) {
    rows.push({
      category: 'validation',
      status: 'error',
      message: `Graph has ${validation.errors.length} validation errors`,
      details: { errors: validation.errors.slice(0, 10) },
    });
  } else {
    rows.push({
      category: 'validation',
      status: 'ok',
      message: 'Graph validation passed',
    });
  }

  // Edge type distribution
  const edgeTypes = ['CONTAINS', 'IMPORTS', 'CALLS', 'EXPOSES', 'CONSUMES',
    'READS', 'WRITES', 'TESTS', 'DEPENDS_ON', 'DOCUMENTS', 'CO_CHANGED'] as const;
  for (const type of edgeTypes) {
    const count = store.countEdges(type);
    if (count > 0) {
      rows.push({
        category: 'edges',
        status: 'ok',
        message: `${type}: ${count} edges`,
      });
    }
  }

  // Orphan check — nodes with no edges
  const nodes = store.listNodes(undefined, 10000);
  let orphanCount = 0;
  for (const node of nodes) {
    const edges = store.getNeighbors(node.id);
    if (edges.length === 0) {
      orphanCount++;
    }
  }
  if (orphanCount > 0) {
    rows.push({
      category: 'orphans',
      status: 'warn',
      message: `${orphanCount} nodes with no edges`,
    });
  } else {
    rows.push({
      category: 'orphans',
      status: 'ok',
      message: 'All nodes have at least one edge',
    });
  }

  return rows;
}

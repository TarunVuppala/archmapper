// Flow reconstruction — meaningful flows from evidence-backed graph paths.

import type { FlowResult, FlowStep, RiskChip, GraphNode } from './types.js';
import type { GraphStore } from './store.js';

export function reconstructFlow(
  store: GraphStore,
  startId: string,
  maxDepth = 10
): FlowResult {
  const steps: FlowStep[] = [];
  const risks: RiskChip[] = [];
  const visited = new Set<string>();

  let currentId: string | null = startId;
  let depth = 0;

  while (currentId && depth < maxDepth) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const node = store.getNode(currentId);
    if (!node) break;

    steps.push({
      nodeId: currentId,
      label: `${node.kind}: ${node.name}`,
    });

    // Find the next step in the flow
    const outEdges = store.getOutEdges(currentId);

    // Priority: EXPOSES → API → CONSUMES → CALLS → WRITES → PUBLISHES → CONTAINS
    const flowPriority = [
      'EXPOSES', 'CONSUMES', 'CALLS', 'WRITES', 'PUBLISHES',
      'CONTAINS', 'DEPENDS_ON', 'DOCUMENTS', 'TESTS',
    ];

    let nextEdge = null;
    for (const type of flowPriority) {
      const edge = outEdges.find(e => e.type === type);
      if (edge) {
        nextEdge = edge;
        break;
      }
    }

    if (!nextEdge) {
      break;
    }

    steps[steps.length - 1].edgeType = nextEdge.type;
    steps[steps.length - 1].evidence = nextEdge.evidence[0];

    // Risk detection
    if (nextEdge.type === 'WRITES') {
      risks.push({
        kind: 'db_write',
        message: `DB write in flow: ${node.name}`,
        nodeId: currentId,
      });
    }

    currentId = nextEdge.to;
    depth++;
  }

  const flowId = `flow:${startId}:${Date.now()}`;

  return {
    ok: true,
    flowId,
    steps,
    risks,
  };
}

// Flow from a specific API endpoint
export function flowFromAPI(
  store: GraphStore,
  method: string,
  path: string
): FlowResult {
  const apiId = `api:${method.toUpperCase()}:${path}`;
  return reconstructFlow(store, apiId);
}

// Flow from a function
export function flowFromFunction(
  store: GraphStore,
  functionId: string
): FlowResult {
  return reconstructFlow(store, functionId);
}

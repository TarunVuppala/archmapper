// plan_change — bounded mutation envelope for humans and agents.

import type { ChangePlan, GraphNode } from './types.js';
import type { GraphStore } from './store.js';
import { computeImpact } from './impact.js';
import { evaluatePolicies } from './policy.js';

export function planChange(store: GraphStore, target: GraphNode): ChangePlan {
  const impact = computeImpact(store, [target.id], { direction: 'downstream' });

  const files = new Set<string>();
  if (target.path) files.add(target.path);
  for (const n of impact.nodes) {
    if (n.path && (n.kind === 'Function' || n.kind === 'Method' || n.kind === 'Class' || n.kind === 'File' || n.kind === 'Test')) {
      files.add(n.path);
    }
  }

  const contracts = impact.nodes
    .filter(n => n.kind === 'Contract' || n.kind === 'API')
    .map(n => n.id);

  const requiredEvidence = [
    'Do not invent edges; cite graph IDs or source snippets.',
    'Stay inside allowedFiles.',
    'Re-run impact after the change.',
  ];
  if (contracts.length > 0) requiredEvidence.push('Update contracts/OpenAPI if a public route changes.');
  if (impact.testsToRun.length === 0) requiredEvidence.push('No linked tests — add or name the tests you will run.');

  return {
    target,
    allowedFiles: [...files],
    impacted: impact.nodes.map(n => n.id),
    policies: evaluatePolicies(store),
    testsToRun: impact.testsToRun,
    contracts,
    risks: impact.riskChips,
    requiredEvidence,
  };
}

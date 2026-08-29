// Deterministic verification primitives. Agent claims stay provisional until this passes.

import type { ChangePlan, VerificationResult } from './types.js';
import type { GraphStore } from './store.js';

export function verifyGraph(store: GraphStore): VerificationResult {
  const validation = store.validateGraph();
  const checks = [
    {
      name: 'endpoints_exist',
      passed: validation.ok,
      message: validation.ok
        ? 'All edges point at existing nodes'
        : validation.errors.slice(0, 5).join('; '),
    },
    {
      name: 'non_empty',
      passed: store.nodeCount > 0,
      message: store.nodeCount > 0
        ? `${store.nodeCount} nodes in the graph`
        : 'Graph is empty — run archmap init or sync',
    },
  ];
  return { ok: checks.every(c => c.passed), checks };
}

export function verifyPlanEnvelope(
  plan: ChangePlan,
  changedFiles: string[]
): VerificationResult {
  const allowed = new Set(plan.allowedFiles.map(f => f.replace(/\\/g, '/')));
  const outside = changedFiles
    .map(f => f.replace(/\\/g, '/'))
    .filter(f => !allowed.has(f) && ![...allowed].some(a => f.endsWith(a) || f.includes('/' + a)));

  const checks = [
    {
      name: 'inside_envelope',
      passed: outside.length === 0,
      message: outside.length === 0
        ? 'All changed files are inside the allowed envelope'
        : `Files outside envelope: ${outside.join(', ')}`,
    },
    {
      name: 'has_target',
      passed: Boolean(plan.target?.id),
      message: plan.target?.id ? `Target ${plan.target.id}` : 'Plan has no target',
    },
  ];
  return { ok: checks.every(c => c.passed), checks };
}

export function verifyEvidenceSnippets(store: GraphStore, limit = 200): VerificationResult {
  const edges = store.listEdges(undefined, limit);
  let missing = 0;
  for (const e of edges) {
    if (e.sources.includes('user') || e.sources.includes('agent')) continue;
    if (!e.evidence || e.evidence.length === 0) missing++;
  }
  const checks = [{
    name: 'evidence_present',
    passed: missing === 0,
    message: missing === 0
      ? 'Sampled edges carry evidence'
      : `${missing} automated edges in sample have no evidence`,
  }];
  return { ok: checks.every(c => c.passed), checks };
}

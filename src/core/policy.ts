// Policy evaluation.
// Checks graph state against architecture policies loaded from policies.yaml.

import type { PolicyViolation, PolicySeverity, PolicyResult } from './types.js';
import type { GraphStore } from './store.js';

export interface Policy {
  id: string;
  severity: PolicySeverity;
  description?: string;
}

// Built-in default policies from AGENTS.md
const BUILT_IN_POLICIES: Policy[] = [
  {
    id: 'public-api-requires-contract',
    severity: 'warning',
    description: 'Public route changed without OpenAPI/contract update',
  },
  {
    id: 'critical-must-have-tests',
    severity: 'warning',
    description: 'Critical node has zero TESTS edges',
  },
  {
    id: 'seeded-ownership-violation',
    severity: 'warning',
    description: 'WRITES edge violates seeded ownership',
  },
  {
    id: 'major-bump-critical-path',
    severity: 'warning',
    description: 'Major version bump on a critical path',
  },
];

export function evaluatePolicies(
  store: GraphStore,
  customPolicies?: Policy[]
): PolicyResult {
  const violations: PolicyViolation[] = [];
  const policies = [...BUILT_IN_POLICIES, ...(customPolicies ?? [])];

  for (const policy of policies) {
    switch (policy.id) {
      case 'public-api-requires-contract':
        checkPublicApiRequiresContract(store, violations);
        break;
      case 'critical-must-have-tests':
        checkCriticalMustHaveTests(store, violations);
        break;
      // Additional built-in policies can be added here
      default:
        // Custom policies — no built-in check, pass through
        break;
    }
  }

  return { ok: violations.length === 0, violations };
}

function checkPublicApiRequiresContract(store: GraphStore, violations: PolicyViolation[]): void {
  // Find API/Route nodes that have EXPOSES edges but no linked Contract
  const apis = store.listNodes('API');
  const routes = store.listNodes('Route');
  const contracts = store.listNodes('Contract');

  const contractPaths = new Set(contracts.map(c => c.path).filter(Boolean));

  for (const api of [...apis, ...routes]) {
    const exposesEdges = store.getOutEdges(api.id).filter(e => e.type === 'EXPOSES');
    if (exposesEdges.length > 0 && api.path && !contractPaths.has(api.path)) {
      violations.push({
        policyId: 'public-api-requires-contract',
        severity: 'warning',
        message: `API/Route ${api.name} (${api.id}) has no linked contract`,
        nodeId: api.id,
      });
    }
  }
}

function checkCriticalMustHaveTests(store: GraphStore, violations: PolicyViolation[]): void {
  // Find critical nodes (tagged 'critical') with no TESTS edges
  const allNodes = store.listNodes();
  for (const node of allNodes) {
    if (node.tags?.includes('critical')) {
      const testEdges = store.getInEdges(node.id).filter(e => e.type === 'TESTS');
      if (testEdges.length === 0) {
        violations.push({
          policyId: 'critical-must-have-tests',
          severity: 'warning',
          message: `Critical node ${node.name} (${node.id}) has no tests`,
          nodeId: node.id,
        });
      }
    }
  }
}

// Canonical context state export.
// Generates context.json — a structured, exportable snapshot derived from the ONE graph.
// The graph remains authoritative; context must be regenerable from graph + source state.

import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphNode, GraphEdge, GraphView, Explanation, ImpactResult, PolicyResult, HealthRow } from './types.js';
import type { GraphStore } from './store.js';
import { projectView } from './views.js';
import { computeImpact } from './impact.js';
import { explainImpact } from './explain.js';
import { healthCheck } from './health.js';
import { evaluatePolicies } from './policy.js';
import { RAGIndex } from './rag.js';
import { computeInsights } from './insights.js';
import { verifyGraph } from './verify.js';

export interface ContextSnapshot {
  version: string;
  generatedAt: string;
  repoPath: string;
  projectName: string;
  summary: {
    totalNodes: number;
    totalEdges: number;
    nodeKinds: Record<string, number>;
    edgeKinds: Record<string, number>;
    languages: string[];
  };
  architecture: {
    heightView: GraphView;
    services: string[];
    tables: string[];
    apis: string[];
    externals: string[];
    tests: string[];
    infra: string[];
  };
  insights: {
    cycles: number;
    highlyCoupled: string[];
    bottlenecks: string[];
    hubs: string[];
    isolated: string[];
    hotspots: string[];
  };
  health: HealthRow[];
  policies: PolicyResult;
  verification: { ok: boolean; checks: Array<{ name: string; passed: boolean; message: string }> };
  selectedComponent?: {
    node: GraphNode;
    explanation: Explanation;
    impact?: ImpactResult;
  };
}

/**
 * Generate a context snapshot from the current graph state.
 */
export function generateContext(
  store: GraphStore,
  repoPath: string,
  projectName?: string,
  focusNodeId?: string
): ContextSnapshot {
  const now = new Date().toISOString();

  // Summary stats
  const allNodes = store.listAllNodes();
  const nodeKinds: Record<string, number> = {};
  const edgeKinds: Record<string, number> = {};
  const languages = new Set<string>();

  for (const node of allNodes) {
    nodeKinds[node.kind] = (nodeKinds[node.kind] || 0) + 1;
    if (node.lang) languages.add(node.lang);
  }

  const allEdges = store.listEdges(undefined, 100000);
  for (const edge of allEdges) {
    edgeKinds[edge.type] = (edgeKinds[edge.type] || 0) + 1;
  }

  // Architecture views
  const heightView = projectView(store, 'height');
  const services = store.listNodes('Service', 100).map(n => n.name);
  const tables = store.listNodes('Table', 100).map(n => n.name);
  const apis = store.listNodes('API', 100).map(n => n.name);
  const externals = store.listNodes('External', 100).map(n => n.name);
  const tests = store.listNodes('Test', 100).map(n => n.name);
  const infra = store.listNodes('Infra', 100).map(n => n.name);

  // Insights
  const insights = computeInsights(store);

  // Health
  const health = healthCheck(store);

  // Policies
  const policies = evaluatePolicies(store);

  // Verification
  const verification = verifyGraph(store);

  // Selected component (if any)
  let selectedComponent: ContextSnapshot['selectedComponent'];
  if (focusNodeId) {
    const node = store.getNode(focusNodeId) || store.resolveNode(focusNodeId);
    if (node) {
      const impact = computeImpact(store, [node.id], { direction: 'downstream' });
      const explanation = explainImpact(store, impact);
      selectedComponent = { node, explanation, impact };
    }
  }

  return {
    version: '0.1.0',
    generatedAt: now,
    repoPath,
    projectName: projectName || repoPath.split(/[/\\]/).pop() || 'unknown',
    summary: {
      totalNodes: allNodes.length,
      totalEdges: allEdges.length,
      nodeKinds,
      edgeKinds,
      languages: [...languages],
    },
    architecture: {
      heightView,
      services,
      tables,
      apis,
      externals,
      tests,
      infra,
    },
    insights: {
      cycles: insights.cycles.length,
      highlyCoupled: insights.highlyCoupled.map(i => `${i.name} (${i.reason})`),
      bottlenecks: insights.bottlenecks.map(i => `${i.name} (${i.reason})`),
      hubs: insights.hubs.map(i => `${i.name} (${i.reason})`),
      isolated: insights.isolated.map(i => `${i.name} (${i.reason})`),
      hotspots: insights.hotspots.map(i => `${i.name} (${i.reason})`),
    },
    health,
    policies,
    verification,
    selectedComponent,
  };
}

/**
 * Save context.json to the .archmap directory.
 */
export function saveContext(
  repoPath: string,
  context: ContextSnapshot
): void {
  const dir = join(repoPath, '.archmap');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(
    join(dir, 'context.json'),
    JSON.stringify(context, null, 2),
    'utf-8'
  );
}

/**
 * Load context.json from the .archmap directory.
 */
export function loadContext(repoPath: string): ContextSnapshot | null {
  const contextPath = join(repoPath, '.archmap', 'context.json');
  if (!existsSync(contextPath)) return null;
  try {
    return JSON.parse(readFileSync(contextPath, 'utf-8'));
  } catch {
    return null;
  }
}

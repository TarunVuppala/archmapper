// Public Core operations. CLI, MCP, HTTP, and UI call these — they do not reimplement them.

import type {
  CanonicalEnvelope,
  ChangePlan,
  Explanation,
  GraphNode,
  GraphView,
  ImpactResult,
  InsightsResult,
  ViewMode,
  WhyPath,
} from './types.js';
import { envelope, errorEnvelope } from './types.js';
import type { GraphStore } from './store.js';
import { computeImpact, type ImpactOptions } from './impact.js';
import { findWhyPaths } from './why.js';
import { computeInsights } from './insights.js';
import { mermaidFromView, projectView } from './views.js';
import { explainImpact, explainNode } from './explain.js';
import { planChange } from './plan.js';
import { evaluatePolicies } from './policy.js';
import { healthCheck } from './health.js';
import { reconstructFlow } from './flow.js';
import { RAGIndex } from './rag.js';
import { verifyGraph } from './verify.js';
import { resolveDocs } from './docs.js';

export function resolve(store: GraphStore, idOrName: string): GraphNode | undefined {
  return store.resolveNode(idOrName);
}

export function impactOp(
  store: GraphStore,
  idOrName: string,
  options: ImpactOptions = {}
): CanonicalEnvelope<ImpactResult | { error: string }> {
  const node = store.resolveNode(idOrName);
  if (!node) return errorEnvelope(`Node not found: ${idOrName}`);
  return envelope(computeImpact(store, [node.id], options));
}

export function whyPathOp(
  store: GraphStore,
  from: string,
  to: string
): CanonicalEnvelope<{ paths: WhyPath[] } | { error: string }> {
  const a = store.resolveNode(from);
  const b = store.resolveNode(to);
  if (!a) return errorEnvelope(`Node not found: ${from}`);
  if (!b) return errorEnvelope(`Node not found: ${to}`);
  return envelope({ paths: findWhyPaths(store, a.id, b.id) });
}

export function insightsOp(store: GraphStore): CanonicalEnvelope<InsightsResult> {
  return envelope(computeInsights(store));
}

export function viewOp(
  store: GraphStore,
  mode: ViewMode = 'height',
  focusId?: string
): CanonicalEnvelope<GraphView> {
  return envelope(projectView(store, mode, focusId));
}

export function explainOp(
  store: GraphStore,
  idOrName: string
): CanonicalEnvelope<(Explanation & { impact: ImpactResult }) | { error: string }> {
  const node = store.resolveNode(idOrName);
  if (!node) return errorEnvelope(`Node not found: ${idOrName}`);
  const impact = computeImpact(store, [node.id], { direction: 'downstream' });
  return envelope({ ...explainImpact(store, impact), impact });
}

export function planChangeOp(
  store: GraphStore,
  idOrName: string
): CanonicalEnvelope<ChangePlan | { error: string }> {
  const node = store.resolveNode(idOrName);
  if (!node) return errorEnvelope(`Node not found: ${idOrName}`);
  return envelope(planChange(store, node));
}

export function symbolOp(store: GraphStore, idOrName: string) {
  const node = store.resolveNode(idOrName);
  if (!node) return errorEnvelope(`Node not found: ${idOrName}`);
  return envelope({
    node,
    neighbors: store.getNeighbors(node.id),
    explanation: explainNode(store, node),
  });
}

export function searchOp(store: GraphStore, q: string, limit = 20) {
  const rag = new RAGIndex();
  rag.indexNodes(store);
  return envelope(rag.searchWithNodes(store, q, limit));
}

export function healthOp(store: GraphStore) {
  return envelope({
    rows: healthCheck(store),
    verification: verifyGraph(store),
    policies: evaluatePolicies(store),
  });
}

export function flowOp(store: GraphStore, idOrName: string) {
  const node = store.resolveNode(idOrName);
  if (!node) return errorEnvelope(`Node not found: ${idOrName}`);
  return envelope(reconstructFlow(store, node.id));
}

export function graphExportOp(
  store: GraphStore,
  format: 'json' | 'mermaid' = 'json',
  mode: ViewMode = 'height'
) {
  const view = projectView(store, mode);
  if (format === 'mermaid') {
    return { ok: true, mermaid: mermaidFromView(view), view };
  }
  return envelope(view);
}

export function docsOp(store: GraphStore, idOrName: string) {
  return envelope(resolveDocs(store, idOrName));
}

export { mermaidFromView };

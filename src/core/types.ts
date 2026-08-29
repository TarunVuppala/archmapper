// Core canonical types for Architecture Mapper
// One graph, one set of contracts, one truth.

// ─── Node Kinds ────────────────────────────────────────────────────────────────

export type NodeKind =
  | 'Repo'
  | 'File'
  | 'Module'
  | 'Package'
  | 'Class'
  | 'Interface'
  | 'Function'
  | 'Method'
  | 'Service'
  | 'API'
  | 'Route'
  | 'Table'
  | 'Column'
  | 'Event'
  | 'Job'
  | 'Test'
  | 'External'
  | 'Infra'
  | 'Doc'
  | 'Contract'
  | 'ConfigKey';

// ─── Edge Kinds ────────────────────────────────────────────────────────────────

export type EdgeKind =
  | 'CONTAINS'
  | 'IMPORTS'
  | 'CALLS'
  | 'IMPLEMENTS'
  | 'EXPOSES'
  | 'CONSUMES'
  | 'READS'
  | 'WRITES'
  | 'PUBLISHES'
  | 'SUBSCRIBES'
  | 'TESTS'
  | 'DEPENDS_ON'
  | 'DOCUMENTS'
  | 'CONSTRAINED_BY'
  | 'CO_CHANGED'
  | 'BROKE_BEFORE'
  | 'USES_CONFIG';

// ─── Evidence ──────────────────────────────────────────────────────────────────

export interface Evidence {
  file: string;
  line: number;
  snippet: string;
}

export type EdgeSource =
  | 'parser'
  | 'git'
  | 'openapi'
  | 'lockfile'
  | 'coverage'
  | 'infra'
  | 'runtime'
  | 'user'
  | 'agent'
  | 'llm';

// ─── Node ──────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;              // stable ID: fn:path:qualname, api:METHOD:path, etc.
  kind: NodeKind;
  name: string;            // human-readable name
  path?: string;           // file path (relative, POSIX)
  lang?: string;           // language
  signature?: string;      // function/method signature
  startLine?: number;
  endLine?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
  updated_at: string;      // ISO-8601
}

// ─── Edge ──────────────────────────────────────────────────────────────────────

export interface GraphEdge {
  id: string;              // e_<hash>
  type: EdgeKind;
  from: string;            // node ID
  to: string;              // node ID
  evidence: Evidence[];
  sources: EdgeSource[];
  confidence: number;      // 0..1
  conflict: boolean;
  metadata?: Record<string, unknown>;
  updated_at: string;      // ISO-8601
}

// ─── Graph ─────────────────────────────────────────────────────────────────────

export interface Graph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
  // Adjacency lists for fast traversal
  outEdges: Map<string, GraphEdge[]>;  // nodeId → edges where from == nodeId
  inEdges: Map<string, GraphEdge[]>;   // nodeId → edges where to == nodeId
}

// ─── Impact Result ─────────────────────────────────────────────────────────────

export interface WhyPath {
  steps: WhyPathStep[];
  evidence: Evidence[];
}

export interface WhyPathStep {
  from: string;    // node ID
  to: string;      // node ID
  edgeType: EdgeKind;
  evidence?: Evidence;
}

export type RiskKind =
  | 'downstream'
  | 'db_write'
  | 'external'
  | 'untested'
  | 'churn'
  | 'critical'
  | 'conflict';

export interface RiskChip {
  kind: RiskKind;
  message: string;
  nodeId?: string;
}

export interface ImpactResult {
  ok: boolean;
  startIds: string[];
  direction: 'downstream' | 'upstream';
  counts: Record<NodeKind, number>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: WhyPath[];
  testsToRun: string[];
  riskChips: RiskChip[];
  docsForExternals: string[];
  suggestedReviewers: string[];
}

// ─── Diff Impact ───────────────────────────────────────────────────────────────

export type ChangeKind = 'added' | 'removed' | 'signature_changed' | 'body_only';

export interface SymbolDiff {
  nodeId: string;
  change: ChangeKind;
  oldSignature?: string;
  newSignature?: string;
}

export interface DiffImpactResult {
  ok: boolean;
  base: string;
  head: string;
  changedSymbols: SymbolDiff[];
  impact: ImpactResult;
  contractDeltas: string[];
}

// ─── Canonical Envelope ────────────────────────────────────────────────────────

export interface CanonicalEnvelope<T = unknown> {
  ok: boolean;
  version: string;
  timestamp: string;
  data: T;
  evidence_used: boolean;
}

// ─── Search ────────────────────────────────────────────────────────────────────

export interface SearchResult {
  node: GraphNode;
  score: number;
  snippet?: string;
}

// ─── Flow ──────────────────────────────────────────────────────────────────────

export interface FlowStep {
  nodeId: string;
  edgeType?: EdgeKind;
  evidence?: Evidence;
  label: string;
}

export interface FlowResult {
  ok: boolean;
  flowId: string;
  steps: FlowStep[];
  risks: RiskChip[];
}

// ─── Health ────────────────────────────────────────────────────────────────────

export interface HealthRow {
  category: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  details?: Record<string, unknown>;
}

// ─── Policy ────────────────────────────────────────────────────────────────────

export type PolicySeverity = 'info' | 'warning' | 'error';

export interface PolicyViolation {
  policyId: string;
  severity: PolicySeverity;
  message: string;
  nodeId?: string;
  edgeId?: string;
  evidence?: Evidence[];
}

export interface PolicyResult {
  ok: boolean;
  violations: PolicyViolation[];
}

// ─── Pin ───────────────────────────────────────────────────────────────────────

export interface PinInput {
  type?: EdgeKind;
  from?: string;
  to?: string;
  evidence?: Evidence;
  source: 'user' | 'agent';
}

// ─── Serialization ─────────────────────────────────────────────────────────────

export function envelope<T>(data: T, evidenceUsed = true): CanonicalEnvelope<T> {
  return {
    ok: true,
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    data,
    evidence_used: evidenceUsed,
  };
}

export function errorEnvelope(message: string): CanonicalEnvelope<{ error: string }> {
  return {
    ok: false,
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    data: { error: message },
    evidence_used: false,
  };
}

// ─── Architecture Insights ─────────────────────────────────────────────────────

export interface InsightItem {
  id: string;
  name: string;
  kind: NodeKind;
  score: number;
  reason: string;
  path?: string;
}

export interface CycleInsight {
  nodes: string[];
  edgeTypes: EdgeKind[];
}

export interface InsightsResult {
  ok: boolean;
  cycles: CycleInsight[];
  highlyCoupled: InsightItem[];
  bottlenecks: InsightItem[];
  hubs: InsightItem[];
  isolated: InsightItem[];
  hotspots: InsightItem[];
  largeDownstream: InsightItem[];
}

// ─── Graph projections (not a second graph) ────────────────────────────────────

export type ViewMode = 'height' | 'depth' | 'call' | 'api' | 'db' | 'flow';

export interface GraphView {
  mode: ViewMode;
  focusId?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ─── Human explanation ─────────────────────────────────────────────────────────

export interface Explanation {
  title: string;
  summary: string;
  bullets: string[];
  paths: string[];
  risks: string[];
  tests: string[];
  nextSteps: string[];
}

// ─── Change plan ───────────────────────────────────────────────────────────────

export interface ChangePlan {
  target: GraphNode;
  allowedFiles: string[];
  impacted: string[];
  policies: PolicyResult;
  testsToRun: string[];
  contracts: string[];
  risks: RiskChip[];
  requiredEvidence: string[];
}

// ─── Verification ──────────────────────────────────────────────────────────────

export interface VerificationResult {
  ok: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    message: string;
  }>;
}

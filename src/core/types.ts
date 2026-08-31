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

export interface AffectedGroup {
  kind: NodeKind;
  label: string;
  icon: string;
  items: Array<{
    id: string;
    name: string;
    path?: string;
    startLine?: number;
    evidence?: Evidence;
  }>;
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
  /** Affected items grouped by kind for display */
  affectedByKind?: AffectedGroup[];
  /** Natural language summary of the impact */
  summary?: string;
  /** Severity rating: low, medium, critical */
  severity?: 'low' | 'medium' | 'critical';
}

// ─── Diff Impact ───────────────────────────────────────────────────────────────

export type ChangeKind = 'added' | 'removed' | 'signature_changed' | 'body_only';

export interface SymbolDiff {
  nodeId: string;
  change: ChangeKind;
  oldSignature?: string;
  newSignature?: string;
}

export type DiffMode = 'range' | 'working' | 'staged';

export interface DiffImpactResult {
  ok: boolean;
  base: string;
  head: string;
  mode: DiffMode;
  changedSymbols: SymbolDiff[];
  impact: ImpactResult;
  contractDeltas: string[];
  changedPaths: string[];
  gitError?: string;
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

// ─── Agent layer ───────────────────────────────────────────────────────────────

export type AgentRole =
  | 'orchestrator'
  | 'explorer'
  | 'architect'
  | 'impact-analyzer'
  | 'implementer'
  | 'reviewer'
  | 'verifier'
  | 'docs-agent'
  | 'security-agent'
  | 'test-agent'
  | 'prompt-agent'
  | 'cost-agent';

export type RouteTier = 'deterministic' | 'cheap' | 'strong' | 'independent_verifier';

export interface AgentBudget {
  max_agents: number;
  max_depth: number;
  max_model_calls: number;
  max_input_tokens: number;
  max_output_tokens: number;
  max_runtime_seconds: number;
}

export interface PromptContract {
  task: string;
  role: AgentRole;
  goal: string;
  context: Record<string, unknown>;
  evidence: string[];
  constraints: string[];
  allowed_tools: string[];
  allowed_files: string[];
  forbidden_actions: string[];
  output_schema: string;
  success_criteria: string[];
  verification: { independent: boolean; max_retries: number };
  budget: AgentBudget;
}

export interface LLMUsage {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  estimated_cost: number;
  latency_ms: number;
}

export interface RouteDecision {
  tier: RouteTier;
  model: string | null;
  reason: string;
  use_llm: boolean;
}

export interface ContextPack {
  task: string;
  facts: string[];
  evidence: Array<{ id: string; file?: string; line?: number; snippet?: string }>;
  constraints: string[];
  open_questions: string[];
  artifacts: string[];
}

export interface CouplingHypothesis {
  from: string;
  to: string;
  type: EdgeKind;
  snippet: string;
  file?: string;
  line?: number;
  confidence: number;
  accepted: boolean;
  reason: string;
}

export interface AgentSkillResult {
  skill: string;
  ok: boolean;
  role: AgentRole;
  data: unknown;
  evidence_used: boolean;
  llm_used: boolean;
}

export interface DebateProposal {
  id: string;
  title: string;
  body: string;
  assumptions?: string[];
}

export interface DebateResult {
  ok: boolean;
  winner: string | null;
  rationale: string;
  proposals: DebateProposal[];
  critiques: Array<{ proposalId: string; failures: string[] }>;
  evidence_checked: boolean;
  llm_used: boolean;
}

export interface AgentRunResult {
  run_id: string;
  parent_run_id?: string;
  agent: string;
  role: AgentRole;
  task: string;
  contract: PromptContract;
  status: 'completed' | 'failed' | 'blocked' | 'needs_human';
  route: RouteDecision;
  context: ContextPack;
  skills: AgentSkillResult[];
  artifact: Record<string, unknown>;
  hypotheses: CouplingHypothesis[];
  decisions: string[];
  verification: VerificationResult;
  usage: LLMUsage[];
  open_questions: string[];
  llm_configured: boolean;
}

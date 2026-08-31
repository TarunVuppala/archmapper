// Bounded, verifiable agent layer over the ONE graph.
// LLM is optional: skills run deterministically first; models only narrate,
// hypothesize, or debate using payload evidence. They never upsert edges.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AgentBudget,
  AgentRole,
  AgentRunResult,
  AgentSkillResult,
  ChangePlan,
  ContextPack,
  CouplingHypothesis,
  DebateProposal,
  DebateResult,
  GraphNode,
  LLMUsage,
  PromptContract,
  VerificationResult,
} from './types.js';
import type { GraphStore } from './store.js';
import { computeImpact } from './impact.js';
import { computeDiffImpact } from './diff.js';
import { planChange } from './plan.js';
import { findWhyPaths } from './why.js';
import { computeInsights } from './insights.js';
import { resolveDocs } from './docs.js';
import { verifyGraph, verifyPlanEnvelope } from './verify.js';
import { evaluatePolicies } from './policy.js';
import { explainImpact } from './explain.js';
import { RAGIndex } from './rag.js';
import { Journal } from './journal.js';
import { reconstructFlow } from './flow.js';
import { chatComplete, isLLMConfigured, loadLLMConfig } from '../llm/client.js';
import { routeTask } from '../llm/router.js';
import { narrateImpact, summarizeDocs } from '../llm/narrate.js';

export const DEFAULT_BUDGET: AgentBudget = {
  max_agents: 8,
  max_depth: 3,
  max_model_calls: 20,
  max_input_tokens: 100000,
  max_output_tokens: 30000,
  max_runtime_seconds: 300,
};

const SKILLS = [
  'impact-analysis',
  'repository-exploration',
  'docs-resolution',
  'change-planning',
  'safe-implementation',
  'code-review',
  'graph-verification',
  'test-selection',
  'contract-check',
  'prompt-review',
  'cost-routing',
] as const;

export type SkillName = typeof SKILLS[number];

export const SKILL_META: Record<SkillName, { role: AgentRole; description: string; side_effects: string }> = {
  'impact-analysis': { role: 'impact-analyzer', description: 'Bounded blast radius + why-paths', side_effects: 'none' },
  'repository-exploration': { role: 'explorer', description: 'Search graph + insights', side_effects: 'none' },
  'docs-resolution': { role: 'docs-agent', description: 'In-repo / lockfile docs for a component', side_effects: 'none' },
  'change-planning': { role: 'architect', description: 'Mutation envelope: allowed files, tests, policies', side_effects: 'none' },
  'safe-implementation': { role: 'implementer', description: 'Returns envelope only — does not edit files', side_effects: 'none' },
  'code-review': { role: 'reviewer', description: 'Review a diff against graph impact and policies', side_effects: 'none' },
  'graph-verification': { role: 'verifier', description: 'Graph consistency + envelope checks', side_effects: 'none' },
  'test-selection': { role: 'test-agent', description: 'Tests on the impact path', side_effects: 'none' },
  'contract-check': { role: 'security-agent', description: 'Policy / contract violations', side_effects: 'none' },
  'prompt-review': { role: 'prompt-agent', description: 'Critique a prompt contract; never applies it', side_effects: 'none' },
  'cost-routing': { role: 'cost-agent', description: 'Choose deterministic vs cheap vs strong', side_effects: 'none' },
};

function archmapDir(repoPath: string): string {
  return join(repoPath, '.archmap');
}

function persistRun(repoPath: string, result: AgentRunResult): void {
  const dir = join(archmapDir(repoPath), 'agent-runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${result.run_id}.json`), JSON.stringify(result, null, 2), 'utf-8');
}

export function buildContract(task: string, extras: Partial<PromptContract> = {}): PromptContract {
  return {
    task,
    role: extras.role ?? 'orchestrator',
    goal: extras.goal ?? `Answer using the architecture graph: ${task}`,
    context: extras.context ?? {},
    evidence: extras.evidence ?? [],
    constraints: extras.constraints ?? [
      'Do not invent graph edges or node IDs',
      'Use only returned graph evidence',
      'Do not modify files unless the envelope explicitly allows it',
      'Do not rewrite governing prompts',
    ],
    allowed_tools: extras.allowed_tools ?? [
      'search', 'symbol', 'neighbors', 'blast_radius', 'diff_impact',
      'why_path', 'docs_for', 'tests_to_run', 'plan_change', 'health',
    ],
    allowed_files: extras.allowed_files ?? [],
    forbidden_actions: extras.forbidden_actions ?? [
      'upsert_edge_without_evidence',
      'edit_outside_envelope',
      'self_modify_prompts',
      'upload_full_source',
    ],
    output_schema: extras.output_schema ?? 'AgentRunResult',
    success_criteria: extras.success_criteria ?? [
      'Every path has evidence',
      'Referenced nodes exist in the graph payload',
      'Verification checks pass or failures are reported',
    ],
    verification: extras.verification ?? { independent: true, max_retries: 2 },
    budget: extras.budget ?? { ...DEFAULT_BUDGET },
  };
}

export function resolveTarget(store: GraphStore, task: string): GraphNode | undefined {
  const quoted = task.match(/[`'"]([A-Za-z0-9_./:-]+)[`'"]/);
  const change = task.match(/(?:change|impact|modify|edit|touch|break)\s+(?:of\s+)?([A-Za-z_][A-Za-z0-9_.]*)/i);
  const ident = quoted?.[1] || change?.[1];
  if (ident) {
    const hit = store.resolveNode(ident) || store.searchNodes(ident, 1)[0];
    if (hit) return hit;
  }
  const tokens = task.split(/[^A-Za-z0-9_]+/).filter(t => t.length > 3);
  for (const t of tokens.slice().reverse()) {
    const hit = store.resolveNode(t) || store.searchNodes(t, 1)[0];
    if (hit && hit.kind !== 'File' && hit.kind !== 'Repo') return hit;
  }
  return undefined;
}

function snippetAt(repoPath: string, file: string, line: number, radius = 2): string | null {
  const abs = join(repoPath, file);
  if (!existsSync(abs)) return null;
  try {
    const lines = readFileSync(abs, 'utf-8').split(/\r?\n/);
    const start = Math.max(0, line - 1 - radius);
    const end = Math.min(lines.length, line + radius);
    return lines.slice(start, end).join('\n');
  } catch {
    return null;
  }
}

function looksSecret(s: string): boolean {
  return /api[_-]?key|secret|password|bearer\s+[a-z0-9]|private[_-]?key/i.test(s);
}

class BudgetTracker {
  calls = 0;
  input = 0;
  output = 0;
  constructor(readonly budget: AgentBudget, readonly started = Date.now()) {}
  get timedOut(): boolean {
    return (Date.now() - this.started) / 1000 > this.budget.max_runtime_seconds;
  }
  get llmBlocked(): boolean {
    return this.calls >= this.budget.max_model_calls
      || this.input >= this.budget.max_input_tokens
      || this.output >= this.budget.max_output_tokens
      || this.timedOut;
  }
  add(u?: LLMUsage): void {
    if (!u) return;
    this.calls += 1;
    this.input += u.input_tokens;
    this.output += u.output_tokens;
  }
}

export async function runSkill(
  store: GraphStore,
  skill: SkillName | string,
  inputs: Record<string, unknown> = {},
  opts: { repoPath?: string; tracker?: BudgetTracker } = {},
): Promise<AgentSkillResult> {
  const meta = SKILL_META[skill as SkillName];
  const role = meta?.role ?? 'explorer';
  const repoPath = opts.repoPath ?? '.';
  const tracker = opts.tracker ?? new BudgetTracker(DEFAULT_BUDGET);
  const id = String(inputs.id || inputs.q || inputs.target || '');
  const node = id ? (store.resolveNode(id) || store.searchNodes(id, 1)[0]) : undefined;

  const wrap = (data: unknown, llm_used = false): AgentSkillResult => ({
    skill,
    ok: true,
    role,
    data,
    evidence_used: true,
    llm_used,
  });

  switch (skill) {
    case 'impact-analysis': {
      if (!node) return { skill, ok: false, role, data: { error: 'target not found' }, evidence_used: false, llm_used: false };
      const impact = computeImpact(store, [node.id], { direction: 'downstream', maxDepth: 5, maxPaths: 7 });
      let explanation = explainImpact(store, impact);
      let llm_used = false;
      if (!tracker.llmBlocked && isLLMConfigured()) {
        const n = await narrateImpact(explanation, impact);
        explanation = n.explanation;
        tracker.add(n.usage);
        llm_used = Boolean(n.usage);
      }
      return wrap({ impact, explanation, target: node }, llm_used);
    }
    case 'repository-exploration': {
      const q = String(inputs.q || inputs.task || id || '');
      const rag = new RAGIndex();
      rag.indexNodes(store);
      const hits = q ? rag.searchWithNodes(store, q, 12) : [];
      const insights = computeInsights(store);
      return wrap({
        hits: hits.map(h => ({ id: h.node.id, name: h.node.name, kind: h.node.kind, score: h.score, path: h.node.path })),
        insights: {
          cycles: insights.cycles.length,
          coupled: insights.highlyCoupled.slice(0, 5),
          bottlenecks: insights.bottlenecks.slice(0, 5),
          hubs: insights.hubs.slice(0, 5),
        },
      });
    }
    case 'docs-resolution': {
      const docs = resolveDocs(store, id || String(inputs.name || ''));
      let summary: string | undefined;
      let llm_used = false;
      if (!tracker.llmBlocked && isLLMConfigured() && docs.docs.length) {
        const excerpts = docs.docs.slice(0, 4).map(d => ({
          name: d.name,
          path: d.path,
          text: d.path ? (snippetAt(repoPath, d.path, 1, 12) ?? undefined) : undefined,
        })).filter(e => !looksSecret(e.text || ''));
        const s = await summarizeDocs(docs.target?.name ?? id, excerpts);
        if (s) { summary = s.summary; tracker.add(s.usage); llm_used = true; }
      }
      return wrap({ ...docs, summary }, llm_used);
    }
    case 'change-planning':
    case 'safe-implementation': {
      if (!node) return { skill, ok: false, role, data: { error: 'target not found' }, evidence_used: false, llm_used: false };
      const plan = planChange(store, node);
      return wrap({
        plan,
        note: skill === 'safe-implementation'
          ? 'Implementer may edit ONLY plan.allowedFiles. This skill does not write files.'
          : undefined,
      });
    }
    case 'test-selection': {
      if (!node) return wrap({ tests: [], inferredCommand: null });
      const impact = computeImpact(store, [node.id], { direction: 'downstream', maxDepth: 3 });
      const tests = impact.nodes.filter(n => n.kind === 'Test').map(n => ({ id: n.id, name: n.name, path: n.path }));
      return wrap({ tests, inferredCommand: tests.length ? 'npm test' : null, testsToRun: impact.testsToRun });
    }
    case 'contract-check': {
      return wrap({ ...evaluatePolicies(store), target: node?.id });
    }
    case 'graph-verification': {
      const graph = verifyGraph(store);
      const plan = inputs.plan as ChangePlan | undefined;
      const files = (inputs.changedFiles as string[] | undefined) ?? [];
      const envelope = plan ? verifyPlanEnvelope(plan, files) : { ok: true, checks: [] as VerificationResult['checks'] };
      return wrap({ graph, envelope, ok: graph.ok && envelope.ok });
    }
    case 'cost-routing': {
      const decision = routeTask({ task: String(inputs.task || id), kind: String(inputs.kind || 'orchestrate') });
      return wrap(decision);
    }
    case 'code-review': {
      const diff = computeDiffImpact(store, { mode: 'working', repoPath });
      const impact = diff.impact;
      let review = 'Deterministic review: see changedSymbols, riskChips, and policy violations.';
      let llm_used = false;
      if (!tracker.llmBlocked && isLLMConfigured() && diff.changedSymbols.length) {
        const allowed = impact.nodes.map(n => n.name).slice(0, 40);
        const r = await chatComplete({
          model: loadLLMConfig().strongModel,
          json: true,
          maxTokens: 700,
          messages: [
            {
              role: 'system',
              content:
                'You are an independent code reviewer. Use only the supplied graph/diff evidence. Do not invent files or APIs. Return JSON { findings: string[], risks: string[], tests: string[], verdict: "ok"|"warn"|"block" }.',
            },
            {
              role: 'user',
              content: JSON.stringify({
                changedSymbols: diff.changedSymbols.slice(0, 20),
                changedPaths: diff.changedPaths.slice(0, 20),
                riskChips: impact.riskChips,
                paths: impact.paths.slice(0, 5),
                allowed_names: allowed,
              }),
            },
          ],
        });
        if (r) {
          tracker.add(r.usage);
          llm_used = true;
          review = r.json ? JSON.stringify(r.json) : r.text;
        }
      }
      return wrap({ diff: { changedSymbols: diff.changedSymbols, changedPaths: diff.changedPaths }, impactCounts: impact.counts, review }, llm_used);
    }
    case 'prompt-review': {
      const proposal = String(inputs.proposal || inputs.prompt || '');
      let critique = 'Prompt changes cannot weaken evidence, verification, or graph-truth rules. They require explicit approval.';
      let llm_used = false;
      if (!tracker.llmBlocked && isLLMConfigured() && proposal) {
        const r = await chatComplete({
          model: loadLLMConfig().cheapModel,
          maxTokens: 400,
          messages: [
            {
              role: 'system',
              content: 'Review a proposed prompt-contract change. Reject anything that weakens evidence, verification, or allows silent self-modification. Return a short critique. Do not approve.',
            },
            { role: 'user', content: proposal.slice(0, 4000) },
          ],
        });
        if (r) { critique = r.text; tracker.add(r.usage); llm_used = true; }
      }
      return wrap({ approved: false, critique, note: 'prompt-agent has no authority to apply changes' }, llm_used);
    }
    default:
      return { skill, ok: false, role, data: { error: `Unknown skill: ${skill}`, known: SKILLS }, evidence_used: false, llm_used: false };
  }
}

async function hiddenCoupling(
  store: GraphStore,
  node: GraphNode,
  repoPath: string,
  tracker: BudgetTracker,
): Promise<{ hypotheses: CouplingHypothesis[]; usage?: LLMUsage }> {
  if (tracker.llmBlocked || !isLLMConfigured() || !node.path) return { hypotheses: [] };
  const snippet = snippetAt(repoPath, node.path, node.startLine ?? 1, 8);
  if (!snippet || looksSecret(snippet)) return { hypotheses: [] };
  const neighbors = store.getNeighbors(node.id).slice(0, 12).map(e => ({
    type: e.type, from: e.from, to: e.to,
  }));
  const r = await chatComplete({
    model: loadLLMConfig().strongModel,
    json: true,
    maxTokens: 500,
    messages: [
      {
        role: 'system',
        content:
          'Propose ONLY possible hidden couplings that are visible in the snippet (dynamic calls, stringly-typed routes, env keys). Return JSON { hypotheses: [{ from, to, type, snippet, file, line, confidence, reason }] }. Do not invent files. If none, hypotheses: [].',
      },
      {
        role: 'user',
        content: JSON.stringify({
          node: { id: node.id, name: node.name, path: node.path, kind: node.kind },
          existing_edges: neighbors,
          snippet: snippet.slice(0, 1200),
        }),
      },
    ],
  });
  if (!r) return { hypotheses: [] };
  tracker.add(r.usage);
  const raw = Array.isArray(r.json?.hypotheses) ? r.json.hypotheses : [];
  const hypotheses: CouplingHypothesis[] = [];
  for (const h of raw.slice(0, 5)) {
    const file = String(h.file || node.path || '');
    const snip = String(h.snippet || '');
    const src = (file ? snippetAt(repoPath, file, Number(h.line) || node.startLine || 1, 6) : snippet) ?? '';
    const grounded = Boolean(snip) && Boolean(src) && src.replace(/\s+/g, ' ').includes(snip.slice(0, 40).replace(/\s+/g, ' '));
    hypotheses.push({
      from: String(h.from || node.id),
      to: String(h.to || ''),
      type: h.type || 'CALLS',
      snippet: snip.slice(0, 160),
      file,
      line: Number(h.line) || undefined,
      confidence: Math.min(0.7, Number(h.confidence) || 0.4),
      accepted: false,
      reason: grounded
        ? String(h.reason || 'snippet present in file — still a hypothesis, not a graph edge')
        : 'rejected: cited snippet not found in the file',
    });
  }
  return { hypotheses, usage: r.usage };
}

function reverseQuestions(store: GraphStore, task: string, target?: GraphNode): string[] {
  if (target) return [];
  const hits = store.searchNodes(task.split(/\s+/).pop() || task, 5);
  if (hits.length >= 2) {
    return [
      `Which component is the target: ${hits.slice(0, 3).map(h => `${h.name} (${h.kind})`).join(', ')}?`,
    ];
  }
  return [
    'Which function, API, table, or service should this change start from?',
    'Is this a downstream impact question or an implementation plan?',
  ];
}

export async function orchestrate(
  store: GraphStore,
  task: string,
  options: {
    repoPath?: string;
    contract?: Partial<PromptContract>;
    parent_run_id?: string;
    journal?: boolean;
  } = {},
): Promise<AgentRunResult> {
  const repoPath = options.repoPath ?? '.';
  const contract = buildContract(task, { role: 'orchestrator', ...options.contract });
  const tracker = new BudgetTracker(contract.budget);
  const route = routeTask({ task, kind: 'orchestrate', difficulty: 'high', ambiguous: !resolveTarget(store, task) });
  const skills: AgentSkillResult[] = [];
  const usage: LLMUsage[] = [];
  const decisions: string[] = [];
  const hypotheses: CouplingHypothesis[] = [];

  const target = resolveTarget(store, task);
  const questions = reverseQuestions(store, task, target);
  const context: ContextPack = {
    task,
    facts: target ? [`target=${target.id}`, `kind=${target.kind}`, target.path ? `path=${target.path}` : ''].filter(Boolean) : [],
    evidence: [],
    constraints: contract.constraints,
    open_questions: questions,
    artifacts: [],
  };

  const runSkillTracked = async (name: SkillName, inputs: Record<string, unknown>) => {
    if (skills.length >= contract.budget.max_agents || tracker.timedOut) return;
    const result = await runSkill(store, name, inputs, { repoPath, tracker });
    skills.push(result);
    return result;
  };

  await runSkillTracked('cost-routing', { task, kind: 'orchestrate' });
  await runSkillTracked('repository-exploration', { q: task, task });

  if (target) {
    const impactS = await runSkillTracked('impact-analysis', { id: target.id });
    await runSkillTracked('docs-resolution', { id: target.id });
    await runSkillTracked('test-selection', { id: target.id });
    await runSkillTracked('change-planning', { id: target.id });
    await runSkillTracked('contract-check', { id: target.id });
    const flow = reconstructFlow(store, target.id);
    context.artifacts.push('flow');
    const pack = impactS?.data as { impact?: { paths?: Array<{ steps: Array<{ evidence?: { file: string; line: number; snippet: string } }> }> } } | undefined;
    for (const p of pack?.impact?.paths ?? []) {
      for (const s of p.steps) {
        if (s.evidence) context.evidence.push({ id: target.id, file: s.evidence.file, line: s.evidence.line, snippet: s.evidence.snippet });
      }
    }
    const coupling = await hiddenCoupling(store, target, repoPath, tracker);
    hypotheses.push(...coupling.hypotheses);
    if (coupling.usage) usage.push(coupling.usage);
    decisions.push(`Target resolved to ${target.id}`);
    decisions.push(`Flow has ${flow.steps.length} steps`);
    context.facts.push(`flow_steps=${flow.steps.length}`);
  } else {
    decisions.push('No graph target resolved — reverse-prompting instead of guessing');
  }

  await runSkillTracked('graph-verification', {});
  await runSkillTracked('code-review', {});

  const planSkill = skills.find(s => s.skill === 'change-planning');
  const plan = (planSkill?.data as { plan?: ChangePlan } | undefined)?.plan;
  const verification = verifyGraph(store);
  if (plan) {
    const env = verifyPlanEnvelope(plan, plan.allowedFiles);
    verification.checks.push(...env.checks);
    verification.ok = verification.ok && env.ok;
  }

  let synthesis: string | undefined;
  if (route.use_llm && !tracker.llmBlocked && target) {
    const impactSkill = skills.find(s => s.skill === 'impact-analysis');
    const names = ((impactSkill?.data as any)?.impact?.nodes ?? []).map((n: GraphNode) => n.name).slice(0, 40);
    const r = await chatComplete({
      model: loadLLMConfig().strongModel,
      maxTokens: 500,
      messages: [
        {
          role: 'system',
          content:
            'Synthesize a change-safety brief for an engineer. Use only names in allowed_names. Do not invent edges. 4-6 sentences covering impact, tests, envelope, and risks.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            task,
            target: target.name,
            facts: context.facts,
            skills: skills.map(s => ({ skill: s.skill, ok: s.ok })),
            allowed_names: names,
            hypotheses: hypotheses.filter(h => !h.reason.startsWith('rejected')),
          }),
        },
      ],
    });
    if (r) {
      tracker.add(r.usage);
      usage.push(r.usage);
      synthesis = r.text;
      decisions.push('LLM synthesis used only payload names');
    }
  } else {
    decisions.push(isLLMConfigured() ? 'LLM skipped by budget/route' : 'No LLM configured — deterministic orchestration only');
  }

  const status: AgentRunResult['status'] =
    questions.length && !target ? 'needs_human'
    : verification.ok ? 'completed'
    : 'blocked';

  const result: AgentRunResult = {
    run_id: `run_${randomUUID().slice(0, 8)}`,
    parent_run_id: options.parent_run_id,
    agent: 'orchestrator',
    role: 'orchestrator',
    task,
    contract,
    status,
    route,
    context,
    skills,
    artifact: {
      target: target ? { id: target.id, name: target.name, kind: target.kind, path: target.path } : null,
      plan: plan ?? null,
      synthesis: synthesis ?? null,
      llm: {
        configured: isLLMConfigured(),
        provider: loadLLMConfig().provider,
        model_calls: tracker.calls,
        input_tokens: tracker.input,
        output_tokens: tracker.output,
      },
    },
    hypotheses,
    decisions,
    verification,
    usage,
    open_questions: questions,
    llm_configured: isLLMConfigured(),
  };

  persistRun(repoPath, result);
  if (options.journal !== false) {
    try {
      new Journal(archmapDir(repoPath)).append('agent_run', {
        run_id: result.run_id,
        task,
        status,
        role: result.role,
        skills: skills.map(s => s.skill),
        model_calls: tracker.calls,
        verification_ok: verification.ok,
      });
    } catch { /* journal optional */ }
  }
  return result;
}

export async function agentRun(
  store: GraphStore,
  task: string,
  contract: Partial<PromptContract> = {},
  repoPath = '.',
): Promise<AgentRunResult> {
  return orchestrate(store, task, { repoPath, contract });
}

export function agentVerify(
  store: GraphStore,
  artifact: {
    changedFiles?: string[];
    plan?: ChangePlan;
    claims?: string[];
  } = {},
): VerificationResult {
  const checks: VerificationResult['checks'] = [];
  const graph = verifyGraph(store);
  checks.push(...graph.checks);

  if (artifact.plan) {
    const env = verifyPlanEnvelope(artifact.plan, artifact.changedFiles ?? []);
    checks.push(...env.checks);
  } else if (artifact.changedFiles?.length) {
    checks.push({
      name: 'envelope_required',
      passed: false,
      message: 'changedFiles provided without a plan envelope — refuse to accept',
    });
  }

  for (const claim of artifact.claims ?? []) {
    const node = store.getNode(claim) || store.resolveNode(claim);
    checks.push({
      name: `claim_${claim}`,
      passed: Boolean(node),
      message: node ? `Claim ${claim} exists in the graph` : `Claim ${claim} is not a graph node — unverified`,
    });
  }

  const conflictEdges = store.listEdges(undefined, 5000).filter(e => e.conflict);
  checks.push({
    name: 'no_unexplained_conflicts',
    passed: conflictEdges.length === 0,
    message: conflictEdges.length === 0
      ? 'No conflict edges'
      : `${conflictEdges.length} conflict edge(s) on the graph`,
  });

  return { ok: checks.every(c => c.passed), checks };
}

export async function agentDebate(
  store: GraphStore,
  proposals: DebateProposal[],
  evidence: string[] = [],
  repoPath = '.',
): Promise<DebateResult> {
  const existing = proposals.map(p => {
    const ids = [...`${p.body} ${p.title}`.matchAll(/\b(?:fn|api|table|svc|cls|file|ext):[^\s]+/g)].map(m => m[0]);
    const present = ids.filter(id => Boolean(store.getNode(id)));
    const missing = ids.filter(id => !store.getNode(id));
    return { id: p.id, present, missing, score: present.length - missing.length * 2 };
  });

  const critiques = existing.map(e => ({
    proposalId: e.id,
    failures: e.missing.length
      ? e.missing.map(id => `cited ${id} which is not in the graph`)
      : e.present.length === 0
        ? ['no graph IDs cited — cannot verify from evidence']
        : [],
  }));

  let winner = existing.slice().sort((a, b) => b.score - a.score)[0]?.id ?? null;
  let rationale = winner
    ? `Selected ${winner} because it cites the most existing graph IDs (${existing.find(e => e.id === winner)?.present.length ?? 0}).`
    : 'No proposal could be verified against the graph.';
  let llm_used = false;

  if (isLLMConfigured() && proposals.length >= 2) {
    const r = await chatComplete({
      model: loadLLMConfig().strongModel,
      json: true,
      maxTokens: 600,
      messages: [
        {
          role: 'system',
          content:
            'You are the orchestrator of an architecture debate. Argue only from supplied graph evidence. Return JSON { winner: string, rationale: string }. Do not invent node IDs.',
        },
        {
          role: 'user',
          content: JSON.stringify({ proposals, evidence, graph_scores: existing, critiques }),
        },
      ],
    });
    if (r?.json?.winner && proposals.some(p => p.id === r.json.winner)) {
      winner = r.json.winner;
      rationale = String(r.json.rationale || rationale);
      llm_used = true;
    }
  }

  const result: DebateResult = {
    ok: Boolean(winner),
    winner,
    rationale,
    proposals,
    critiques,
    evidence_checked: true,
    llm_used,
  };
  try {
    new Journal(archmapDir(repoPath)).append('agent_debate', {
      winner, rationale, proposal_ids: proposals.map(p => p.id), llm_used,
    });
  } catch { /* optional */ }
  return result;
}

export function recordEvent(
  store: GraphStore,
  input: {
    kind?: 'incident' | 'coverage' | 'otel' | 'stack';
    from?: string;
    to?: string;
    message?: string;
    file?: string;
    line?: number;
  },
  repoPath = '.',
): { ok: boolean; edge?: unknown; journaled: boolean } {
  const now = new Date().toISOString();
  let edge;
  if (input.from && input.to) {
    edge = store.upsertEdgeByEndpoints(
      'BROKE_BEFORE',
      input.from,
      input.to,
      [{ file: input.file ?? 'record_event', line: input.line ?? 0, snippet: (input.message ?? input.kind ?? 'event').slice(0, 160) }],
      input.kind === 'coverage' ? ['coverage'] : ['runtime'],
    );
  }
  try {
    new Journal(archmapDir(repoPath)).append('record_event', {
      kind: input.kind ?? 'incident',
      from: input.from,
      to: input.to,
      message: input.message,
      at: now,
    });
  } catch { /* optional */ }
  return { ok: true, edge, journaled: true };
}

export function listSkills(): Array<{ name: string; role: AgentRole; description: string; side_effects: string }> {
  return SKILLS.map(name => ({ name, ...SKILL_META[name] }));
}

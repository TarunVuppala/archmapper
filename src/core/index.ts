// Architecture Mapper Core — the ONE source of truth.
// Surfaces (CLI / ui / mcp / serve) import this module. They must not
// reimplement graph, impact, evidence, identity, or verification.

export { GraphStore } from './store.js';
export { computeImpact, type ImpactOptions } from './impact.js';
export { computeDiffImpact, diffSymbols, gitChangedFiles, gitChangedPaths, type DiffOptions, type ChangedFile } from './diff.js';
export { evaluatePolicies, type Policy } from './policy.js';
export { RAGIndex, type RAGChunk } from './rag.js';
export { Journal, type JournalEntry } from './journal.js';
export { healthCheck } from './health.js';
export { reconstructFlow, flowFromAPI, flowFromFunction } from './flow.js';
export { findWhyPaths } from './why.js';
export { computeInsights } from './insights.js';
export { projectView, mermaidFromView } from './views.js';
export { explainImpact, explainNode, formatPath } from './explain.js';
export { planChange } from './plan.js';
export { identifyFromGraph } from './identify.js';
export { loadSeed, applySeed, type SeedFile } from './seed.js';
export { verifyGraph, verifyPlanEnvelope, verifyEvidenceSnippets } from './verify.js';
export { resolveDocs } from './docs.js';
export {
  orchestrate, agentRun, agentVerify, agentDebate, runSkill, recordEvent,
  buildContract, listSkills, resolveTarget, DEFAULT_BUDGET,
} from './agent.js';
export * from './ops.js';
export * from './ids.js';
export * from './types.js';

// Capability/cost router. Deterministic first; LLM only when it earns it.
// Not tied to one vendor — model names come from env / LLMConfig.

import type { RouteDecision, RouteTier } from '../core/types.js';
import { loadLLMConfig } from './client.js';

export interface RouteInput {
  kind?: string;
  difficulty?: 'low' | 'medium' | 'high';
  security?: boolean;
  needsTools?: boolean;
  ambiguous?: boolean;
  critical?: boolean;
  task?: string;
}

const DETERMINISTIC = new Set([
  'parse', 'parsing', 'graph', 'git', 'diff', 'schema', 'search', 'neighbors',
  'impact', 'why_path', 'health', 'policy', 'tests', 'pin', 'sync',
]);

const CHEAP = new Set([
  'summary', 'summaries', 'classify', 'classification', 'narrate', 'narration',
  'route', 'routing', 'name', 'label',
]);

const STRONG = new Set([
  'architecture', 'plan_change', 'plan', 'orchestrate', 'coupling', 'incident',
  'debate', 'review', 'dynamic',
]);

export function routeTask(input: RouteInput = {}): RouteDecision {
  const cfg = loadLLMConfig();
  const kind = (input.kind || '').toLowerCase();
  const task = (input.task || '').toLowerCase();
  const blob = `${kind} ${task}`;

  if (input.security || input.critical || kind === 'verify' || kind === 'prompt-review') {
    return {
      tier: 'independent_verifier',
      model: cfg.configured ? cfg.strongModel : null,
      reason: 'Critical / security / verification work uses an independent verifier after deterministic checks',
      use_llm: cfg.configured && Boolean(input.ambiguous || input.critical || input.security),
    };
  }

  if (DETERMINISTIC.has(kind)) {
    return {
      tier: 'deterministic',
      model: null,
      reason: `${kind || 'this task'} is answered from the graph / git / parser — no model call`,
      use_llm: false,
    };
  }

  if (STRONG.has(kind) || input.difficulty === 'high' || input.ambiguous ||
      /\b(architect|plan|hidden|coupling|why did|should we|trade-?off|debate)\b/.test(blob)) {
    return {
      tier: 'strong',
      model: cfg.configured ? cfg.strongModel : null,
      reason: 'Ambiguous architecture / planning / coupling — strong model only if configured',
      use_llm: cfg.configured,
    };
  }

  if (CHEAP.has(kind) || input.difficulty === 'low' ||
      /\b(summar|explain|narrat|classify|name)\b/.test(blob)) {
    return {
      tier: 'cheap',
      model: cfg.configured ? cfg.cheapModel : null,
      reason: 'Summary / classification / narration — cheap model if configured, else deterministic text',
      use_llm: cfg.configured,
    };
  }

  return {
    tier: 'deterministic',
    model: null,
    reason: 'Default: run graph tools first; escalate only if evidence is insufficient',
    use_llm: false,
  };
}

export function modelForTier(tier: RouteTier): string | null {
  const cfg = loadLLMConfig();
  if (!cfg.configured) return null;
  if (tier === 'deterministic') return null;
  if (tier === 'cheap') return cfg.cheapModel;
  return cfg.strongModel;
}

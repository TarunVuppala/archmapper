// Optional intelligence layer. Never invents graph edges or node IDs.
// Works with no LLM configured. When configured, rewrites text using only
// names already in the payload.

import type { Explanation, ImpactResult, LLMUsage } from '../core/types.js';
import { chatComplete, loadLLMConfig } from './client.js';

function allowedNames(impact: ImpactResult, extra: string[] = []): Set<string> {
  return new Set<string>([
    ...impact.nodes.map(n => n.name),
    ...impact.startIds,
    ...extra,
  ]);
}

function leakedUnknown(text: string, allowed: Set<string>): string[] {
  return [...text.matchAll(/\b[A-Z][A-Za-z0-9_]{3,}\b/g)]
    .map(m => m[0])
    .filter(w => !allowed.has(w) && !['Changing', 'This', 'There', 'None', 'True', 'False', 'JSON'].includes(w));
}

export async function narrateImpact(
  explanation: Explanation,
  impact: ImpactResult,
): Promise<{ explanation: Explanation; usage?: LLMUsage }> {
  const cfg = loadLLMConfig();
  if (!cfg.configured) return { explanation };

  const allowed = allowedNames(impact);
  const result = await chatComplete({
    model: cfg.cheapModel,
    temperature: 0,
    maxTokens: 400,
    messages: [
      {
        role: 'system',
        content:
          'You explain software change impact for developers. Use ONLY the provided component names. Do not invent APIs, tables, services, or files. Return 2-4 short sentences. No markdown headings.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          title: explanation.title,
          summary: explanation.summary,
          paths: explanation.paths.slice(0, 7),
          risks: explanation.risks,
          tests: explanation.tests,
          allowed_names: [...allowed].slice(0, 40),
        }),
      },
    ],
  });
  if (!result?.text) return { explanation };
  if (leakedUnknown(result.text, allowed).length > 3) return { explanation };
  return { explanation: { ...explanation, summary: result.text }, usage: result.usage };
}

export async function summarizeDocs(
  targetName: string,
  excerpts: Array<{ name: string; path?: string; text?: string }>,
): Promise<{ summary: string; usage?: LLMUsage } | null> {
  const cfg = loadLLMConfig();
  if (!cfg.configured || excerpts.length === 0) return null;
  const allowed = new Set(excerpts.flatMap(e => [e.name, targetName]));
  const result = await chatComplete({
    model: cfg.cheapModel,
    temperature: 0,
    maxTokens: 350,
    messages: [
      {
        role: 'system',
        content:
          'Summarize retrieved documentation versus the named component. Never invent API parameters. If the text does not mention a parameter, do not claim it exists.',
      },
      {
        role: 'user',
        content: JSON.stringify({ target: targetName, docs: excerpts.slice(0, 6) }),
      },
    ],
  });
  if (!result?.text) return null;
  if (leakedUnknown(result.text, allowed).length > 8) return null;
  return { summary: result.text, usage: result.usage };
}

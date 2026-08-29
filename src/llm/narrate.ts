// Optional intelligence layer. Never invents graph edges or node IDs.
// Works with no LLM configured. When configured, rewrites the deterministic
// explanation using only names already in the payload.

import type { Explanation, ImpactResult } from '../core/types.js';

export async function narrateImpact(
  explanation: Explanation,
  impact: ImpactResult
): Promise<Explanation> {
  const baseUrl = process.env.ARCHMAP_LLM_BASE_URL;
  const apiKey = process.env.ARCHMAP_LLM_API_KEY;
  const model = process.env.ARCHMAP_LLM_MODEL ?? 'grok-4';
  if (!baseUrl || !apiKey) return explanation;

  const allowed = new Set<string>([
    ...impact.nodes.map(n => n.name),
    ...impact.startIds,
  ]);

  const body = {
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You explain software change impact. Use only the provided component names. Do not invent APIs, tables, or services. Return 2-4 short sentences.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          title: explanation.title,
          summary: explanation.summary,
          paths: explanation.paths,
          risks: explanation.risks,
          tests: explanation.tests,
          allowed_names: [...allowed].slice(0, 40),
        }),
      },
    ],
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return explanation;
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return explanation;
    const leaked = [...text.matchAll(/\b[A-Z][A-Za-z0-9_]+\b/g)]
      .map(m => m[0])
      .filter(w => w.length > 3 && !allowed.has(w) && !['Changing', 'This', 'There'].includes(w));
    if (leaked.length > 3) return explanation;
    return { ...explanation, summary: text };
  } catch {
    return explanation;
  }
}

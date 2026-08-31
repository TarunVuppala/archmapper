// Provider-neutral LLM client. Defaults to xAI when XAI_API_KEY is set.
// The rest of the system works with no LLM configured — this module returns null.

import type { LLMUsage } from '../core/types.js';

export interface LLMConfig {
  configured: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  strongModel: string;
  cheapModel: string;
  timeoutMs: number;
}

const XAI_BASE = 'https://api.x.ai/v1';
const DEFAULT_STRONG = 'grok-4.6';
const DEFAULT_CHEAP = 'grok-4.3';

/** USD per million tokens. Operational metadata only — never graph truth. */
const PRICE: Record<string, { in: number; out: number; cached: number }> = {
  'grok-4.6': { in: 2.0, out: 6.0, cached: 0.5 },
  'grok-4.5': { in: 2.0, out: 6.0, cached: 0.3 },
  'grok-4.3': { in: 1.25, out: 2.5, cached: 0.2 },
  'grok-4': { in: 3.0, out: 15.0, cached: 0.75 },
};

export function loadLLMConfig(): LLMConfig {
  const apiKey = (process.env.ARCHMAP_LLM_API_KEY || process.env.XAI_API_KEY || '').trim();
  const explicitBase = (process.env.ARCHMAP_LLM_BASE_URL || '').trim().replace(/\/$/, '');
  const baseUrl = explicitBase || (apiKey ? XAI_BASE : '');
  const provider = baseUrl.includes('x.ai') ? 'xai' : (baseUrl ? 'openai-compatible' : 'none');
  return {
    configured: Boolean(apiKey && baseUrl),
    provider,
    baseUrl,
    apiKey,
    strongModel: process.env.ARCHMAP_LLM_MODEL || DEFAULT_STRONG,
    cheapModel: process.env.ARCHMAP_LLM_CHEAP_MODEL || DEFAULT_CHEAP,
    timeoutMs: Number(process.env.ARCHMAP_LLM_TIMEOUT_MS || 20000),
  };
}

export function isLLMConfigured(): boolean {
  return loadLLMConfig().configured;
}

export function estimateCost(model: string, input: number, output: number, cached = 0): number {
  const p = PRICE[model] ?? { in: 0, out: 0, cached: 0 };
  return (input * p.in + output * p.out + cached * p.cached) / 1_000_000;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

export interface ChatResult {
  text: string;
  json: any | null;
  usage: LLMUsage;
}

function parseJSON(text: string): any | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1].trim() : trimmed;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function chatComplete(req: ChatRequest): Promise<ChatResult | null> {
  const cfg = loadLLMConfig();
  if (!cfg.configured) return null;

  const model = req.model || cfg.strongModel;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);

  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 1200,
        messages: req.messages,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const text = body.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) return null;
    const input = body.usage?.prompt_tokens ?? 0;
    const output = body.usage?.completion_tokens ?? 0;
    const cached = body.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text,
      json: parseJSON(text),
      usage: {
        provider: cfg.provider,
        model,
        input_tokens: input,
        output_tokens: output,
        cached_input_tokens: cached,
        estimated_cost: estimateCost(model, input, output, cached),
        latency_ms: Date.now() - t0,
      },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

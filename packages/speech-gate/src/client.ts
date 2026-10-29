/**
 * Minimal OpenRouter access for the semantic checkers. The HTTP transport is injectable, so a caller
 * can add caching, budgets or mocks without the gate knowing.
 */

export interface TransportResult {
  payload: any;
  latencyMs: number;
  cached: boolean;
}

export type Transport = (url: string, body: Record<string, unknown>) => Promise<TransportResult>;

export interface JsonChatRequest {
  model: string;
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  extra?: Record<string, unknown>;
}

export interface ModelResult<T> {
  value: T;
  latencyMs: number;
  costUsd: number;
  cached: boolean;
}

export interface NoulQuestion {
  instructions: string;
  criteria: { true: string; false: string };
}

export interface ModelClient {
  chatJson<T>(req: JsonChatRequest): Promise<ModelResult<T>>;
  /** A yes/no question to a decision model (OpenRouter Decisions API); returns P(true). */
  decide(model: string, state: Record<string, unknown>, question: NoulQuestion, extra?: Record<string, unknown>): Promise<ModelResult<number>>;
}

export const OPENROUTER = "https://openrouter.ai/api/v1";
/** The Decisions API lives outside /v1. */
export const OPENROUTER_DECISIONS = "https://openrouter.ai/api/alpha/decisions";

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** How long to wait before retrying: the server's Retry-After or rate-limit reset if given, else backoff. */
function retryDelayMs(response: Response, text: string, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (retryAfter > 0) return retryAfter * 1000;
  // OpenRouter puts the reset time (epoch ms) in the error body's metadata.
  const reset = Number(/"X-RateLimit-Reset":"(\d+)"/.exec(text)?.[1]);
  if (reset > Date.now()) return reset - Date.now() + 250;
  return Math.min(60_000, 1000 * 2 ** attempt);
}

export function fetchTransport(apiKey: string, maxAttempts = 8): Transport {
  return async (url, body) => {
    for (let attempt = 0; ; attempt++) {
      const started = performance.now();
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const latencyMs = performance.now() - started;
      const text = await response.text();
      if (RETRY_STATUS.has(response.status) && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, retryDelayMs(response, text, attempt)));
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      return { payload: JSON.parse(text), latencyMs, cached: false };
    }
  };
}

/** Price table fallback, USD per million tokens, for when the API reports no cost. */
export type Prices = Record<string, { input: number; output: number }>;

function costOf(payload: any, model: string, prices: Prices): number {
  const usage = payload?.usage ?? {};
  if (typeof usage.cost === "number") return usage.cost;
  const price = prices[model];
  const input = usage.prompt_tokens ?? usage.input_tokens;
  if (!price || typeof input !== "number") return 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return (input * price.input + output * price.output) / 1e6;
}

export function createOpenRouterClient(transport: Transport, prices: Prices = {}): ModelClient {
  return {
    async chatJson<T>(req: JsonChatRequest): Promise<ModelResult<T>> {
      const { payload, latencyMs, cached } = await transport(`${OPENROUTER}/chat/completions`, {
        model: req.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: req.schemaName, strict: true, schema: req.schema },
        },
        temperature: 0,
        max_tokens: req.maxTokens ?? 200,
        usage: { include: true },
        ...req.extra,
      });
      const choice = payload?.choices?.[0];
      const content: string = choice?.message?.content ?? "";
      if (choice?.finish_reason === "length") throw new Error(`${req.model} hit max_tokens before finishing its JSON`);
      const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
      if (!json) throw new Error(`${req.model} returned no JSON: ${content.slice(0, 120)}`);
      return { value: JSON.parse(json) as T, latencyMs, cached, costUsd: costOf(payload, req.model, prices) };
    },

    async decide(model, state, question, extra = {}) {
      const { payload, latencyMs, cached } = await transport(OPENROUTER_DECISIONS, {
        model,
        state,
        questions: { q: { type: "noul", ...question } },
        ...extra,
      });
      const p = Number(payload?.answers?.q?.noul);
      if (!Number.isFinite(p)) throw new Error(`decision model returned no probability: ${JSON.stringify(payload).slice(0, 200)}`);
      return { value: p, latencyMs, cached, costUsd: costOf(payload, model, prices) };
    },
  };
}

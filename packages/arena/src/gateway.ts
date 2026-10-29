import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpenRouterClient, fetchTransport, type ModelClient, type Transport } from "@voice-arena/speech-gate";
import { ROOT, type Study } from "./config.js";
import { mockResponse } from "./mock.js";

/** What a request is for: routes mock answers and itemizes spend. */
export type Role = "agent" | "caller" | "mutator" | "labeler" | "checker";

export class BudgetExceeded extends Error {}

/**
 * Every model request goes through here: a disk cache keyed by the exact request (reruns only pay
 * for what's new), a hard spend cap, and an offline mock with the same interface.
 */
export class Gateway {
  readonly spend: Record<Role, number> = { agent: 0, caller: 0, mutator: 0, labeler: 0, checker: 0 };
  private readonly cacheDir: string;
  private live: Transport | null = null;
  private nextSlot = new Map<string, number>();

  constructor(
    private readonly study: Study,
    readonly mock: boolean,
  ) {
    this.cacheDir = join(ROOT, ".cache", mock ? "mock" : "openrouter");
  }

  get totalSpend(): number {
    return Object.values(this.spend).reduce((a, b) => a + b, 0);
  }

  transport(role: Role): Transport {
    return async (url, body) => {
      const key = createHash("sha256").update(JSON.stringify([url, body])).digest("hex");
      const path = join(this.cacheDir, key.slice(0, 2), `${key}.json`);
      if (existsSync(path)) {
        const hit = JSON.parse(readFileSync(path, "utf8"));
        return { payload: hit.payload, latencyMs: hit.latencyMs, cached: true };
      }
      if (this.totalSpend >= this.study.budget_usd) {
        throw new BudgetExceeded(`budget of $${this.study.budget_usd} reached`);
      }
      if (!this.mock) await this.throttle(String(body.model));
      const result = this.mock ? mockResponse(role, url, body) : await this.liveTransport()(url, body);
      if (!this.mock) this.spend[role] += costOf(result.payload, String(body.model), this.study);
      mkdirSync(join(this.cacheDir, key.slice(0, 2)), { recursive: true });
      writeFileSync(path, JSON.stringify({ payload: result.payload, latencyMs: result.latencyMs }));
      return result;
    };
  }

  /** Spaces requests to a model evenly when study.yaml caps its requests per minute. */
  private async throttle(model: string): Promise<void> {
    const rpm = this.study.rpm[model];
    if (!rpm) return;
    const gap = 60_000 / rpm;
    const now = Date.now();
    const slot = Math.max(now, (this.nextSlot.get(model) ?? 0));
    this.nextSlot.set(model, slot + gap);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  }

  client(role: Role): ModelClient {
    return createOpenRouterClient(this.transport(role), this.study.prices_per_million);
  }

  private liveTransport(): Transport {
    if (!this.live) {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) throw new Error("OPENROUTER_API_KEY is not set (or use --mock)");
      this.live = fetchTransport(key);
    }
    return this.live;
  }
}

export function costOf(payload: any, model: string, study: Study): number {
  const usage = payload?.usage ?? {};
  if (typeof usage.cost === "number") return usage.cost;
  const price = study.prices_per_million[model];
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return price ? (input * price.input + output * price.output) / 1e6 : 0;
}

/** Runs tasks with at most `limit` in flight, preserving result order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Stable pseudo-random number in [0, 1) from any string: same input, same draw. */
export function hashUnit(s: string): number {
  return parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16) / 0x1_0000_0000;
}

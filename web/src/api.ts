export type Kind = "check" | "llm" | "decision" | "cascade";

export interface CheckerSpec {
  name: string;
  kind: "none" | "deterministic" | "llm" | "decision" | "cascade";
  model?: string;
  then?: string;
}

export interface Config {
  study: { latency_budget_ms: number; max_false_block_rate: number; speech_rate_wps: number; agent: string; labelers: string[] };
  packs: { id: string; title: string; private: boolean; fallback: string; identityPrompt: string; playground?: { sentence: string; turn: string } }[];
  checkers: CheckerSpec[];
  hasKey: boolean;
}

export interface ReportSummary {
  id: string;
  source: "live" | "mock" | "snapshot" | "private-snapshot";
  createdAt: string;
  mock: boolean;
  private: boolean;
  packs: string[];
  checkers: number;
  sentences: number;
}

export type Reference = "supported" | "unsupported" | "uncertain";
export type Origin = "natural" | "planted-numeric" | "planted-semantic";

export interface Item {
  pack: string;
  id: string;
  origin: Origin;
  reference: Reference;
  labelSource: "labelers" | "review" | "construction";
  reviewer?: string;
  callId: string;
  turn: number;
  position: number;
  words: number;
  sentence: string;
}

export interface VerdictRow {
  checker: string;
  pack: string;
  id: string;
  pass: boolean;
  latencyMs: number;
  costUsd: number;
  cached: boolean;
  decidedBy?: string;
  reasons: string[];
  error?: string;
}

export interface Rate {
  k: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
}

export interface Metrics {
  checker: string;
  falseBlock: Rate;
  caught: { natural: Rate; numeric: Rate; semantic: Rate; all: Rate };
  latency: { p50: number; p95: number };
  firstAudio: { p50: number; p95: number };
  midTurnStallMs: number;
  modelShare: number;
  costPerCall: number;
  errors: number;
}

export interface Pick {
  pick: string | null;
  leader: string | null;
  tied: { checker: string; p: number }[];
}

export interface Report {
  results: {
    createdAt: string;
    mock: boolean;
    study: {
      latency_budget_ms: number;
      max_false_block_rate: number;
      speech_rate_wps: number;
      agent: { model: string };
      caller: { model: string };
      mutator: string;
      labelers: string[];
    };
    packs: { id: string; title: string; private: boolean; calls: number; audit: Record<string, number> }[];
    checkers: CheckerSpec[];
    calibrations?: { checker: string; threshold: number; n: number; falseBlockRate: number; packs: string[] }[];
    items: Item[];
    verdicts: VerdictRow[];
    spendUsd: Record<string, number>;
  };
  recommendation: {
    testPacks: string[];
    tunePacks: string[];
    tuneMetrics: Metrics[];
    metrics: Metrics[];
    ineligible: { checker: string; why: string }[];
    withinLimits: Pick;
    mostAccurate: Pick;
    finding: string;
  };
}

export interface TranscriptTurn {
  speaker: "agent" | "caller";
  text: string;
  stage: "verify" | "active" | "wrong-party";
}

export interface CallRecord {
  callId: string;
  pack: string;
  persona: string;
  transcript: TranscriptTurn[];
  actions: { tool: string; args: Record<string, unknown>; description: string }[];
  audit: { rule: string; turn: number; detail: string }[];
  endedBy: string;
}

export interface SentenceRecord {
  id: string;
  callId: string;
  turn: number;
  position: number;
  sentence: string;
  stage: string;
  facts: boolean;
  actions: string[];
  previousCallerTurn: string;
  origin: Origin;
  parentId?: string;
  change?: string;
}

export interface LabelRecord {
  id: string;
  votes: Record<string, { supported: boolean; unsupported_claims: string[] }>;
  reference: Reference;
  source: string;
}

export interface PackData {
  calls: CallRecord[];
  sentences: SentenceRecord[];
  planted: SentenceRecord[];
  labels: LabelRecord[];
}

export async function api<T>(path: string, init?: RequestInit, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, { ...init, signal, headers: { "Content-Type": "application/json", ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail ?? `Request failed (${response.status})`);
  return body as T;
}

export function kindOf(spec: CheckerSpec): Kind {
  if (spec.kind === "llm") return "llm";
  if (spec.kind === "decision") return "decision";
  if (spec.kind === "cascade") return "cascade";
  return "check";
}

export const kindLabel: Record<CheckerSpec["kind"], string> = {
  none: "Baseline",
  deterministic: "Rules",
  llm: "Small LLM",
  decision: "Decision model",
  cascade: "Cascade",
};

export const pct = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`;
export const ms = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? "n/a" : `${Math.round(x)} ms`);
export const usd = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "n/a" : x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`;
export const rate = (r: Rate) => (r.n ? `${pct(r.rate)}` : "n/a");
export const frac = (r: Rate) => (r.n ? `${r.k}/${r.n}` : "");
export const ci = (r: Rate) => (r.n ? `95% CI ${pct(r.lo)}–${pct(r.hi)}` : "");

import type { ItemRow, Results, VerdictRow } from "./runner.js";

export interface Rate {
  k: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
}

/** Wilson 95% interval: honest at small n, where most of these counts live. */
export function wilson(k: number, n: number): Rate {
  if (n === 0) return { k, n, rate: NaN, lo: NaN, hi: NaN };
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { k, n, rate: p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface CheckerMetrics {
  checker: string;
  /** Supported natural sentences the checker would have stopped. */
  falseBlock: Rate;
  caught: { natural: Rate; numeric: Rate; semantic: Rate; all: Rate };
  latency: { p50: number; p95: number };
  /** Hold mode: silence added before the first word of an agent turn. */
  firstAudio: { p50: number; p95: number };
  /** Hold mode: extra silence between sentences, per turn, when a check outlasts the sentence before it. */
  midTurnStallMs: number;
  /** Share of sentences that needed a model call. */
  modelShare: number;
  costPerCall: number;
  errors: number;
}

/**
 * Hold mode timing for one agent turn. All sentence checks start together (the LLM writes faster than
 * speech), sentence k plays once its check is done and sentence k-1 has finished playing.
 */
export function turnDelay(checkMs: number[], words: number[], wordsPerSecond: number): { firstAudio: number; stall: number } {
  let end = 0;
  let spoken = 0;
  checkMs.forEach((c, k) => {
    const start = Math.max(end, c);
    const duration = (words[k]! / wordsPerSecond) * 1000;
    end = start + duration;
    spoken += duration;
  });
  const firstAudio = checkMs[0] ?? 0;
  return { firstAudio, stall: Math.max(0, end - spoken - firstAudio) };
}

export function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export function checkerMetrics(results: Results, checker: string, packFilter?: string): CheckerMetrics {
  const items = results.items.filter((i) => !packFilter || i.pack === packFilter);
  const verdicts = new Map(
    results.verdicts.filter((v) => v.checker === checker && (!packFilter || v.pack === packFilter)).map((v) => [`${v.pack}|${v.id}`, v]),
  );
  const v = (i: ItemRow) => verdicts.get(`${i.pack}|${i.id}`)!;
  const blocked = (xs: ItemRow[]) => xs.filter((i) => !v(i).pass).length;

  const supported = items.filter((i) => i.origin === "natural" && i.reference === "supported");
  const naturalBad = items.filter((i) => i.origin === "natural" && i.reference === "unsupported");
  // Plants the labelers found supported after all are "uncertain" and excluded, like natural ones.
  const numeric = items.filter((i) => i.origin === "planted-numeric" && i.reference === "unsupported");
  const semantic = items.filter((i) => i.origin === "planted-semantic" && i.reference === "unsupported");
  const allBad = [...naturalBad, ...numeric, ...semantic];
  const all = items.map(v);

  const natural = items.filter((i) => i.origin === "natural");
  const turns = groupBy(natural, (i) => `${i.callId}|${i.turn}`);
  const first: number[] = [];
  const stalls: number[] = [];
  for (const turn of turns.values()) {
    turn.sort((a, b) => a.position - b.position);
    const d = turnDelay(turn.map((i) => v(i).latencyMs), turn.map((i) => i.words), results.study.speech_rate_wps);
    first.push(d.firstAudio);
    stalls.push(d.stall);
  }
  const calls = new Set(natural.map((i) => i.callId));
  const naturalCost = natural.reduce((sum, i) => sum + v(i).costUsd, 0);

  return {
    checker,
    falseBlock: wilson(blocked(supported), supported.length),
    caught: {
      natural: wilson(blocked(naturalBad), naturalBad.length),
      numeric: wilson(blocked(numeric), numeric.length),
      semantic: wilson(blocked(semantic), semantic.length),
      all: wilson(blocked(allBad), allBad.length),
    },
    latency: { p50: quantile(all.map((x) => x.latencyMs), 0.5), p95: quantile(all.map((x) => x.latencyMs), 0.95) },
    firstAudio: { p50: quantile(first, 0.5), p95: quantile(first, 0.95) },
    midTurnStallMs: stalls.length ? stalls.reduce((a, b) => a + b, 0) / stalls.length : 0,
    modelShare: all.length ? all.filter((x) => x.decidedBy && x.decidedBy !== "deterministic" && x.decidedBy !== "none").length / all.length : 0,
    costPerCall: calls.size ? naturalCost / calls.size : 0,
    errors: all.filter((x: VerdictRow) => x.error).length,
  };
}

/** Exact two-sided McNemar test on paired catches: does A catch different errors than B by more than chance? */
export function mcnemar(aCaught: boolean[], bCaught: boolean[]): { b: number; c: number; p: number } {
  let b = 0;
  let c = 0;
  aCaught.forEach((a, i) => {
    if (a && !bCaught[i]) b++;
    if (!a && bCaught[i]) c++;
  });
  const n = b + c;
  if (n === 0) return { b, c, p: 1 };
  let tail = 0;
  let coef = 1;
  for (let k = 0; k <= Math.min(b, c); k++) {
    if (k > 0) coef = (coef * (n - k + 1)) / k;
    tail += coef;
  }
  return { b, c, p: Math.min(1, (2 * tail) / 2 ** n) };
}

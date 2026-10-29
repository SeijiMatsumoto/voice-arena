import { describe, expect, it } from "vitest";
import { blocksAt, fitThreshold } from "../src/calibrate.js";
import { checkerMetrics, mcnemar, turnDelay, wilson } from "../src/metrics.js";
import { mutateNumber } from "../src/plant.js";
import { recommend } from "../src/recommend.js";
import type { ItemRow, Results, VerdictRow } from "../src/runner.js";

describe("statistics", () => {
  it("wilson interval stays inside [0, 1] and covers the point estimate", () => {
    const r = wilson(0, 20);
    expect(r.lo).toBe(0);
    expect(r.hi).toBeGreaterThan(0.1);
    const s = wilson(9, 10);
    expect(s.lo).toBeLessThan(0.9);
    expect(s.hi).toBeLessThanOrEqual(1);
  });
  it("mcnemar uses only the discordant pairs", () => {
    expect(mcnemar([true, true, false], [true, true, false]).p).toBe(1);
    // 8 vs 0 discordant: p = 2 * 0.5^8
    const r = mcnemar(Array(8).fill(true), Array(8).fill(false));
    expect(r.p).toBeCloseTo(2 / 256);
  });
});

describe("hold-mode timing", () => {
  it("only the first check delays the turn when later checks finish while earlier sentences play", () => {
    // 10 words at 2.5 wps = 4 s of speech; a 500 ms check on sentence 2 is hidden behind it.
    expect(turnDelay([200, 500], [10, 10], 2.5)).toEqual({ firstAudio: 200, stall: 0 });
  });
  it("a slow later check stalls the turn mid-way", () => {
    // Sentence 1 plays 200..1200 ms; sentence 2's check finishes at 3000 ms.
    expect(turnDelay([200, 3000], [2.5, 2.5], 2.5)).toEqual({ firstAudio: 200, stall: 1800 });
  });
});

describe("planted numeric errors", () => {
  const sources = { knowledge: "A $10 late fee applies. Reconnection costs $25.", actions: [] };
  it("changes a number to one the sources do not contain", () => {
    const m = mutateNumber("There's a $10 late fee.", sources)!;
    expect(m.sentence).toBe("There's a $11 late fee.");
  });
  it("returns null when there is nothing to change", () => {
    expect(mutateNumber("Thanks for confirming.", sources)).toBeNull();
  });
});

function results(verdicts: Record<string, { pass: boolean[]; latency: number; cost: number }>): Results {
  const refs: ItemRow["reference"][] = ["supported", "supported", "supported", "supported", "unsupported", "unsupported", "unsupported", "unsupported"];
  const items: ItemRow[] = refs.map((reference, i) => ({
    pack: "p", id: String(i), origin: "natural", reference, labelSource: "labelers", callId: `c${i}`, turn: 1, position: 0, words: 8, sentence: "",
  }));
  const rows: VerdictRow[] = Object.entries(verdicts).flatMap(([checker, v]) =>
    v.pass.map((pass, i) => ({ checker, pack: "p", id: String(i), pass, latencyMs: v.latency, costUsd: v.cost, cached: false, reasons: [] })),
  );
  return {
    createdAt: "t",
    mock: false,
    study: { latency_budget_ms: 300, max_false_block_rate: 0.05, speech_rate_wps: 2.7 } as Results["study"],
    packs: [{ id: "p", title: "P", private: false, calls: 8, audit: {} }],
    checkers: Object.keys(verdicts).map((name) => ({ name, kind: "llm", enabled: true, extra: {} })),
    items,
    verdicts: rows,
  } as Results;
}

describe("recommend", () => {
  it("excludes checkers over a limit and picks the cheapest of those tied with the leader", () => {
    const sup = [true, true, true, true];
    const rec = recommend(
      results({
        none: { pass: [...sup, true, true, true, true], latency: 0, cost: 0 },
        slow: { pass: [...sup, false, false, false, false], latency: 900, cost: 0.001 },
        fast: { pass: [...sup, false, false, false, true], latency: 100, cost: 0.002 },
        cheap: { pass: [...sup, false, false, true, true], latency: 100, cost: 0.0001 },
      }),
    );
    expect(rec.ineligible.map((x) => x.checker)).toEqual(["slow"]);
    // fast leads among eligible; cheap is not significantly different on 4 errors, and is cheaper.
    expect(rec.withinLimits.leader).toBe("fast");
    expect(rec.withinLimits.pick).toBe("cheap");
    expect(rec.mostAccurate.leader).toBe("slow");
  });
});

describe("decision-model calibration", () => {
  const item = (id: string, pack: string): ItemRow => ({
    pack, id, origin: "natural", reference: "supported", labelSource: "labelers", callId: "c", turn: 1, position: 0, words: 5, sentence: "",
  });
  // 20 correct tuning sentences with P(supported) 0.05, 0.10, ... 1.00, plus one in a test pack.
  const items = [...Array.from({ length: 20 }, (_, i) => item(`t${i}`, "tune")), item("x", "test")];
  const verdicts: VerdictRow[] = [
    ...items.slice(0, 20).map((it, i) => ({ checker: "jev", pack: "tune", id: it.id, pass: true, latencyMs: 0, costUsd: 0, cached: false, reasons: [], pSupported: (i + 1) * 0.05 })),
    { checker: "jev", pack: "test", id: "x", pass: true, latencyMs: 0, costUsd: 0, cached: false, reasons: [], pSupported: 0.01 },
  ];
  it("picks the highest cutoff that keeps false blocks within the limit, using tuning scenarios only", () => {
    // At 0.10, one of 20 (p=0.05) is blocked: 5%. At 0.15, two: 10%. The test-pack sentence is ignored.
    const c = fitThreshold("jev", items, verdicts, 0.05, ["tune"]);
    expect(c.threshold).toBe(0.1);
    expect(c.falseBlockRate).toBeCloseTo(0.05);
    expect(c.n).toBe(20);
  });
  it("keeps rule-decided verdicts (no probability) as they were", () => {
    expect(blocksAt({ ...verdicts[0]!, pSupported: undefined, pass: false }, 0.5)).toBe(true);
    expect(blocksAt({ ...verdicts[0]!, pSupported: undefined, pass: true }, 0.5)).toBe(false);
  });
});

describe("planted errors in the metrics", () => {
  it("counts only plants that are still unsupported; ones the labelers found true are excluded", () => {
    const base = { pack: "p", labelSource: "construction" as const, callId: "c", turn: 1, position: 0, words: 5, sentence: "" };
    const items: ItemRow[] = [
      { ...base, id: "a", origin: "planted-semantic", reference: "unsupported" },
      { ...base, id: "b", origin: "planted-semantic", reference: "uncertain" },
      { ...base, id: "n", origin: "planted-numeric", reference: "unsupported" },
    ];
    const verdicts: VerdictRow[] = items.map((i) => ({ checker: "x", pack: "p", id: i.id, pass: true, latencyMs: 0, costUsd: 0, cached: false, reasons: [] }));
    const r = { study: { speech_rate_wps: 2.7 }, items, verdicts, packs: [], checkers: [] } as unknown as Results;
    const m = checkerMetrics(r, "x");
    expect(m.caught.semantic.n).toBe(1);
    expect(m.caught.all.n).toBe(2);
  });
});

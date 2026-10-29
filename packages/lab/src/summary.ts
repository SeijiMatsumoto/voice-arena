import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Recommendation } from "./recommend.js";
import type { Results } from "./runner.js";

/**
 * arena-summary/1: the shared shape the arenas hub reads (https://github.com/SeijiMatsumoto/arenas).
 * Hand-written fields come from arena.yaml; the rest from the same recommendation the report uses.
 * Schema: https://github.com/SeijiMatsumoto/arenas/blob/main/kit/src/arena_kit/summary.schema.json
 */

const Manifest = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().optional(),
  question: z.string().min(10),
  repo: z.string().url(),
  study: z.string().optional(),
  data: z.string().optional(),
  labels: z.object({
    source: z.enum(["hand-written", "production", "reviewed", "llm-judge", "simulated", "mixed"]),
    note: z.string().optional(),
  }),
  outcome: z.object({
    status: z.enum(["changed", "kept", "pending", "not-applicable"]),
    note: z.string().optional(),
    evidence_url: z.string().url().optional(),
  }),
  caveats: z.array(z.string()).default([]),
});
export type Manifest = z.infer<typeof Manifest>;

export function loadManifest(root: string): Manifest {
  return Manifest.parse(parse(readFileSync(join(root, "arena.yaml"), "utf8")));
}

type Verdict = "pick" | "tied" | "worse" | "other" | "excluded" | "baseline";

export function buildSummary(results: Results, rec: Recommendation, manifest: Manifest, snapshotPath: string, snapshotId: string) {
  const { withinLimits, ineligible } = rec;
  const tied = new Set(withinLimits.tied.map((t) => t.checker));
  const excluded = new Map(ineligible.map((i) => [i.checker, i.why]));
  const verdict = (checker: string): Verdict => {
    if (checker === "none") return "baseline";
    if (checker === withinLimits.pick) return "pick";
    if (excluded.has(checker)) return "excluded";
    if (tied.has(checker)) return "tied";
    return "worse"; // eligible, but McNemar shows it catches fewer than the leader
  };
  const contenders = [...rec.metrics]
    .sort((a, b) => b.caught.all.rate - a.caught.all.rate || a.checker.localeCompare(b.checker))
    .map((m) => ({
      name: m.checker,
      kind: results.checkers.find((c) => c.name === m.checker)?.kind ?? "other",
      quality: m.caught.all.rate,
      latency_ms: m.firstAudio.p95,
      cost_per_1k_usd: m.costPerCall * 1000,
      errors: m.errors,
      verdict: verdict(m.checker),
      note: [
        `blocks ${(m.falseBlock.rate * 100).toFixed(1)}% of correct sentences`,
        excluded.get(m.checker),
      ].filter(Boolean).join("; "),
    }));
  const scored = results.items.filter((i) => rec.testPacks.length === 0 || rec.testPacks.includes(i.pack));
  const { name, title, question, repo, study, data, labels, outcome, caveats } = manifest;
  return {
    schema: "arena-summary/1",
    arena: { name, ...(title ? { title } : {}), question, repo, ...(study ? { study } : {}) },
    snapshot: { id: snapshotId, created_at: results.createdAt, path: snapshotPath },
    headline: rec.finding,
    pick: withinLimits.pick
      ? { name: withinLimits.pick, reason: "Cheapest, then fastest, of the checkers within both limits whose catches don't differ significantly from the leader's." }
      : null,
    metric: { name: "caught", label: "Wrong sentences caught", higher_is_better: true, format: "percent" },
    // The study's limit is on the slowest turns; most turns add no silence, so the median is ~0.
    latency: { stat: "p95", label: "p95 added silence" },
    contenders,
    data: { items: scored.length, ...(data ? { description: data } : {}), labels },
    method: {
      rules: `Eligible = at most ${(results.study.max_false_block_rate * 100).toFixed(0)}% of correct sentences blocked and at most ${results.study.latency_budget_ms} ms p95 added silence; tied = not significantly different from the leader; pick = cheapest, then fastest, tied checker. Latency is p95 silence added before the first word.`,
      test: "exact McNemar, paired",
      alpha: 0.05,
    },
    outcome,
    caveats,
    mock: results.mock,
  };
}

/** Write <snapshot>/summary.json and, unless a newer real one exists, snapshots/latest.json. */
export function writeSummary(dest: string, summary: ReturnType<typeof buildSummary>, updateLatest: boolean): void {
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(join(dest, "summary.json"), text);
  if (!updateLatest) return;
  const latest = join(dirname(dest), "latest.json");
  const current = existsSync(latest) ? JSON.parse(readFileSync(latest, "utf8")) : null;
  if (!current || (current.snapshot.created_at <= summary.snapshot.created_at && !(summary.mock && !current.mock))) {
    writeFileSync(latest, text);
  }
}

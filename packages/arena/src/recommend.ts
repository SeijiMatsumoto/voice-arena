import { checkerMetrics, mcnemar, type CheckerMetrics } from "./metrics.js";
import type { Results } from "./runner.js";

/**
 * Fixed rules, no model: the same report always yields the same picks.
 *  1. A checker is eligible if its false-block rate and its p95 delay before the first word are both
 *     within the study's limits. "none" is never eligible; it is the baseline.
 *  2. The leader catches the most unsupported sentences (natural and planted together).
 *  3. Checkers whose catches don't differ from the leader's (exact McNemar, p >= 0.05) are tied with it.
 *  4. Among the tied, the pick is the cheapest per call, then the fastest.
 *  "Most accurate" ignores the limits and names the leader; its ties are listed, not resolved.
 */

export interface Pick {
  pick: string | null;
  tied: { checker: string; p: number }[];
  leader: string | null;
}

export interface Recommendation {
  /** Held-out scenarios: the picks and the headline use only these. */
  testPacks: string[];
  /** Scenarios prompts and cutoffs were tuned on; reported separately, never in the picks. */
  tunePacks: string[];
  tuneMetrics: CheckerMetrics[];
  metrics: CheckerMetrics[];
  ineligible: { checker: string; why: string }[];
  withinLimits: Pick;
  mostAccurate: Pick;
  finding: string;
}

const ALPHA = 0.05;

function choose(results: Results, metrics: CheckerMetrics[]): Pick {
  const ranked = [...metrics].sort(
    (a, b) => b.caught.all.rate - a.caught.all.rate || a.costPerCall - b.costPerCall || a.checker.localeCompare(b.checker),
  );
  const leader = ranked[0];
  if (!leader) return { pick: null, tied: [], leader: null };
  const bad = results.items.filter((i) => i.reference === "unsupported");
  const caught = (checker: string) => {
    const blocked = new Set(results.verdicts.filter((v) => v.checker === checker && !v.pass).map((v) => `${v.pack}|${v.id}`));
    return bad.map((i) => blocked.has(`${i.pack}|${i.id}`));
  };
  const leaderCaught = caught(leader.checker);
  const tied = ranked
    .map((m) => ({ m, p: m === leader ? 1 : mcnemar(leaderCaught, caught(m.checker)).p }))
    .filter((x) => x.p >= ALPHA);
  const pick = [...tied].sort((a, b) => a.m.costPerCall - b.m.costPerCall || a.m.firstAudio.p95 - b.m.firstAudio.p95)[0]!;
  return { pick: pick.m.checker, leader: leader.checker, tied: tied.map((x) => ({ checker: x.m.checker, p: x.p })) };
}

/** The same results limited to some scenarios. */
export function restrict(results: Results, packs: string[]): Results {
  return {
    ...results,
    packs: results.packs.filter((p) => packs.includes(p.id)),
    items: results.items.filter((i) => packs.includes(i.pack)),
    verdicts: results.verdicts.filter((v) => packs.includes(v.pack)),
  };
}

export function recommend(all: Results): Recommendation {
  const { study } = all;
  const runPacks = all.packs.map((p) => p.id);
  const tunePacks = runPacks.filter((p) => (study.tune_packs ?? []).includes(p));
  // A run over tuning scenarios only has nothing held out; it is then judged on what it has, and says so.
  const testPacks = runPacks.filter((p) => !tunePacks.includes(p));
  const results = restrict(all, testPacks.length ? testPacks : runPacks);
  const tuneMetrics = tunePacks.length ? all.checkers.map((c) => checkerMetrics(restrict(all, tunePacks), c.name)) : [];
  const metrics = results.checkers.map((c) => checkerMetrics(results, c.name));
  const contenders = metrics.filter((m) => m.checker !== "none");
  const ineligible: Recommendation["ineligible"] = [];
  const eligible = contenders.filter((m) => {
    const why: string[] = [];
    if (!(m.falseBlock.rate <= study.max_false_block_rate)) why.push(`blocks ${pct(m.falseBlock.rate)} of correct sentences`);
    if (!(m.firstAudio.p95 <= study.latency_budget_ms)) why.push(`adds ${Math.round(m.firstAudio.p95)} ms p95 before the first word`);
    if (why.length) ineligible.push({ checker: m.checker, why: why.join("; ") });
    return why.length === 0;
  });
  const withinLimits = choose(results, eligible);
  // "Most accurate" names the leader itself; ties are listed, not resolved by price.
  const accurate = choose(results, contenders);
  const mostAccurate = { ...accurate, pick: accurate.leader };

  const bad = results.items.filter((i) => i.reference === "unsupported");
  const natural = bad.filter((i) => i.origin === "natural").length;
  const heldOut = testPacks.length ? `held-out scenario${testPacks.length === 1 ? "" : "s"}` : "scenario(s) that were also used for tuning";
  const scope = `${bad.length} unsupported sentences (${natural} natural, ${bad.length - natural} planted) across ${results.packs.length} ${heldOut}`;
  let finding: string;
  const m = metrics.find((x) => x.checker === withinLimits.pick);
  if (m) {
    finding = `On ${scope}, ${m.checker} caught ${pct(m.caught.all.rate)} while blocking ${pct(m.falseBlock.rate)} of correct sentences, adding ${Math.round(m.firstAudio.p95)} ms p95 before the first word at $${(m.costPerCall * 1000).toFixed(2)} per 1,000 calls.`;
  } else {
    finding = `On ${scope}, no checker stayed within both limits (${pct(study.max_false_block_rate)} false blocks, ${study.latency_budget_ms} ms p95 added before the first word).`;
  }
  const best = metrics.find((x) => x.checker === mostAccurate.pick);
  if (best && best.checker !== withinLimits.pick && (!m || best.caught.all.rate > m.caught.all.rate)) {
    const tied = mostAccurate.tied.some((t) => t.checker === withinLimits.pick);
    finding += ` Ignoring the limits, ${best.checker} caught the most (${pct(best.caught.all.rate)})${m ? (tied ? ", not a significant difference" : ", a significant difference") : ""}.`;
  }
  return { testPacks, tunePacks, tuneMetrics, metrics, ineligible, withinLimits, mostAccurate, finding: (results.mock ? "[MOCK DATA] " : "") + finding };
}

export function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(x < 0.1 && x > 0 ? 1 : 0)}%` : "n/a";
}

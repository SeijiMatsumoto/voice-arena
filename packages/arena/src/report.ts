import { checkerMetrics, type Rate } from "./metrics.js";
import { pct, restrict, type Recommendation } from "./recommend.js";
import type { Results } from "./runner.js";

const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : "n/a");
const rate = (r: Rate) => (r.n ? `${pct(r.rate)} (${r.k}/${r.n}; ${pct(r.lo)}–${pct(r.hi)})` : "n/a");
const short = (r: Rate) => (r.n ? `${pct(r.rate)} (${r.k}/${r.n})` : "n/a");

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

export function renderReport(all: Results, rec: Recommendation): string {
  const { study } = all;
  // Everything below the setup describes held-out scenarios; tuning scenarios get their own section.
  const results = rec.testPacks.length ? restrict(all, rec.testPacks) : all;
  const out: string[] = [];
  out.push("# Speech gate study report", "");
  if (results.mock) out.push("> **MOCK DATA.** Offline stand-in models. These numbers test the pipeline and say nothing about real checkers.", "");
  out.push(`**Finding:** ${rec.finding}`, "");

  const natural = results.items.filter((i) => i.origin === "natural");
  const count = (ref: string) => natural.filter((i) => i.reference === ref).length;
  const reviewed = natural.filter((i) => i.labelSource === "review");
  const reviewers = [...new Set(reviewed.map((i) => i.reviewer ?? "unnamed"))];
  out.push("## Setup", "");
  out.push(
    `- Run: ${results.createdAt}. Agent \`${study.agent.model}\`, simulated callers \`${study.caller.model}\`, planted semantic errors written by \`${study.mutator}\`.`,
    `- Scenarios: ${all.packs.map((p) => `${p.title} (${p.calls} calls${p.private ? ", private" : ""}${rec.tunePacks.includes(p.id) ? ", tuning" : ""})`).join("; ")}.`,
    `- ${natural.length} natural agent sentences. Reference labels from two models that are not contenders (${study.labelers.map((m) => `\`${m}\``).join(", ")}): ${count("supported")} supported, ${count("unsupported")} unsupported, ${count("uncertain")} uncertain (they disagreed; excluded from rates). ${reviewed.length} overridden by review${reviewers.length ? ` (${reviewers.join("; ")})` : ""}. These are model labels, not human ground truth.`,
    `- ${results.items.length - natural.length} planted errors: ${results.items.filter((i) => i.origin === "planted-numeric").length} changed numbers (checked mechanically against the sources) and ${results.items.filter((i) => i.origin === "planted-semantic").length} changed meanings written by a model, of which ${results.items.filter((i) => i.origin === "planted-semantic" && i.reference === "uncertain").length} were excluded because both labelers found the rewrite supported.`,
    `- Limits fixed before the run: at most ${pct(study.max_false_block_rate)} of correct sentences blocked; at most ${study.latency_budget_ms} ms p95 added before the agent's first word. Speech assumed at ${study.speech_rate_wps} words per second.`,
    rec.tunePacks.length
      ? `- **Tuning vs. held out.** Prompts and cutoffs were tuned on ${rec.tunePacks.join(", ")} only. Every number below is from the held-out scenario${rec.testPacks.length === 1 ? "" : "s"} (${rec.testPacks.join(", ")}); tuning results are in their own section.`
      : `- No tuning scenario is in this run; calibrated cutoffs come from \`calibration.json\`.`,
    ...(all.calibrations ?? []).map((c) => `- \`${c.checker}\` cutoff: P(supported) ≥ ${c.threshold}, fitted on ${c.n} correct sentences from ${c.packs.join(", ")} (false blocks there: ${pct(c.falseBlockRate)}).`),
    `- Spend on uncached requests in this run: $${Object.values(all.spendUsd).reduce((a, b) => a + b, 0).toFixed(4)}.`,
    "",
  );

  out.push("## Results", "");
  out.push(
    table(
      ["Checker", "Caught (all)", "Natural errors", "Planted: numbers", "Planted: meaning", "Correct sentences blocked", "Delay before first word p50 / p95 (ms)", "Mid-turn stall (ms)", "Needed a model", "$ / 1k calls", "Errors"],
      rec.metrics.map((m) => [
        `\`${m.checker}\``,
        rate(m.caught.all),
        short(m.caught.natural),
        short(m.caught.numeric),
        short(m.caught.semantic),
        rate(m.falseBlock),
        `${ms(m.firstAudio.p50)} / ${ms(m.firstAudio.p95)}`,
        ms(m.midTurnStallMs),
        pct(m.modelShare),
        (m.costPerCall * 1000).toFixed(2),
        String(m.errors),
      ]),
    ),
    "",
    "Caught = unsupported sentences the checker would have stopped. Rates show the 95% Wilson interval. A checker error blocks the sentence and counts as a block.",
    "",
  );

  out.push("## Picks", "");
  const describe = (label: string, p: Recommendation["withinLimits"]) =>
    p.pick
      ? `- **${label}: \`${p.pick}\`.** Leader on catches: \`${p.leader}\`. Statistically tied with the leader (McNemar p ≥ 0.05): ${p.tied.map((t) => `\`${t.checker}\` (p=${t.p.toFixed(2)})`).join(", ")}; the cheapest of those is picked.`
      : `- **${label}:** none.`;
  out.push(
    describe("Within both limits", rec.withinLimits),
    rec.mostAccurate.pick
      ? `- **Most accurate, ignoring the limits: \`${rec.mostAccurate.pick}\`.** Not significantly different from it: ${rec.mostAccurate.tied.filter((t) => t.checker !== rec.mostAccurate.pick).map((t) => `\`${t.checker}\` (p=${t.p.toFixed(2)})`).join(", ") || "none"}.`
      : "- **Most accurate:** none.",
  );
  for (const x of rec.ineligible) out.push(`- \`${x.checker}\` is outside the limits: ${x.why}.`);
  out.push("");

  const calls = results.packs.reduce((a, p) => a + p.calls, 0);
  const per100 = (n: number) => (calls ? ((n / calls) * 100).toFixed(1) : "n/a");
  out.push("## What callers would hear, per 100 calls", "");
  out.push(
    "Natural sentences only. *Hold* speaks a sentence only after it passes and replaces a blocked one with the fallback line. *Speak then correct* adds no delay, but every error is heard first and caught ones are corrected on the next turn.",
    "",
  );
  out.push(
    table(
      ["Checker", "Hold: errors heard", "Hold: needless fallbacks", "Speak then correct: errors heard", "…of which corrected", "…needless corrections"],
      rec.metrics.map((m) => {
        const missed = m.caught.natural.n - m.caught.natural.k;
        return [`\`${m.checker}\``, per100(missed), per100(m.falseBlock.k), per100(m.caught.natural.n), per100(m.caught.natural.k), per100(m.falseBlock.k)];
      }),
    ),
    "",
  );

  if (results.packs.length > 1) {
    out.push("## By scenario", "");
    out.push(
      table(
        ["Checker", ...results.packs.map((p) => `${p.title}: caught / blocked correct`)],
        results.checkers.map((c) => [
          `\`${c.name}\``,
          ...results.packs.map((p) => {
            const m = checkerMetrics(results, c.name, p.id);
            return `${short(m.caught.all)} / ${short(m.falseBlock)}`;
          }),
        ]),
      ),
      "",
    );
  }

  if (rec.tuneMetrics.length) {
    out.push("## Tuning scenario (not used for picks)", "");
    out.push(
      "Prompts were revised and cutoffs fitted while looking at these results, so they flatter the tuned checkers. Compare with the held-out numbers above.",
      "",
      table(
        ["Checker", "Caught (all)", "Correct sentences blocked", "Delay before first word p95 (ms)"],
        rec.tuneMetrics.map((m) => [`\`${m.checker}\``, rate(m.caught.all), rate(m.falseBlock), ms(m.firstAudio.p95)]),
      ),
      "",
    );
  }

  out.push("## After-call audit (calls as simulated, no gate)", "");
  // The audit isn't tuned, so it covers every scenario in the run.
  const rules = [...new Set(all.packs.flatMap((p) => Object.keys(p.audit)))].sort();
  out.push(
    rules.length
      ? table(["Scenario", "Calls", ...rules], all.packs.map((p) => [p.title, String(p.calls), ...rules.map((r) => String(p.audit[r] ?? 0))]))
      : "No findings.",
    "",
  );

  const examples = results.items.filter((i) => i.origin === "natural" && i.reference === "unsupported").slice(0, 8);
  if (examples.length) {
    out.push("## Natural errors, and who caught them", "");
    for (const ex of examples) {
      const by = results.verdicts.filter((v) => v.pack === ex.pack && v.id === ex.id && !v.pass).map((v) => `\`${v.checker}\``);
      out.push(`- "${ex.sentence}" (${ex.pack}). Caught by: ${by.join(", ") || "none"}.`);
    }
    out.push("");
  }

  out.push(
    "## Caveats",
    "",
    "- Simulated callers are LLMs following personas, not people. Real calls add speech-recognition errors and barge-in, which this replay doesn't model.",
    "- Delay is the measured API time per check from one location, under this run's concurrency, plus a timing model of streamed speech; it is not measured on a phone line.",
    "- Planted errors show what each checker can catch, not how often agents make that error.",
    "- Reference labels come from two models; disagreements are excluded, which removes the hardest cases from the denominators.",
    "",
  );
  return out.join("\n");
}

import { checkerMetrics, type Rate } from "./metrics.js";
import { pct, restrict, type Recommendation } from "./recommend.js";
import type { Results } from "./runner.js";
import { baseName, isVariant, plainName } from "./names.js";
import type { CheckerMetrics } from "./metrics.js";

const ms = (x: number) => (Number.isFinite(x) ? `${Math.round(x)}` : "n/a");
const rate = (r: Rate) => (r.n ? `${pct(r.rate)} (${r.k}/${r.n}; ${pct(r.lo)}–${pct(r.hi)})` : "n/a");
const short = (r: Rate) => (r.n ? `${pct(r.rate)} (${r.k}/${r.n})` : "n/a");

function table(header: string[], rows: string[][]): string {
  return [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}


const pts = (x: number) => `${(x * 100).toFixed(1)} points`;

/**
 * The report, written for a reader with no context: problem, hypothesis, experiment, findings,
 * limitations, next steps, then the full technical tables. Every number is computed from the results.
 */
export function renderReport(all: Results, rec: Recommendation): string {
  const { study } = all;
  const results = rec.testPacks.length ? restrict(all, rec.testPacks) : all;
  const spec = new Map(all.checkers.map((c) => [c.name, c]));
  const name = (checker: string) => plainName(spec.get(checker)!);
  const held = new Map(rec.metrics.map((m) => [m.checker, m]));
  const tuned = new Map(rec.tuneMetrics.map((m) => [m.checker, m]));
  const base = rec.metrics.filter((m) => !isVariant(spec.get(m.checker)!));
  const kind = (k: string) => base.filter((m) => spec.get(m.checker)?.kind === k);
  const pick = rec.withinLimits.pick ? held.get(rec.withinLimits.pick) : undefined;
  const rules = kind("deterministic")[0];
  const judges = kind("llm");
  const decision = kind("decision")[0];
  const range = (xs: number[], f: (x: number) => string) => (xs.length ? (Math.min(...xs) === Math.max(...xs) ? f(xs[0]!) : `${f(Math.min(...xs))}–${f(Math.max(...xs))}`) : "n/a");
  const meets = (m: CheckerMetrics) => m.falseBlock.rate <= study.max_false_block_rate && m.firstAudio.p95 <= study.latency_budget_ms;
  const heldTitles = results.packs.map((p) => p.title);
  const tuneTitles = all.packs.filter((p) => rec.tunePacks.includes(p.id)).map((p) => p.title);
  const naturalAll = all.items.filter((i) => i.origin === "natural");
  const naturalHeld = results.items.filter((i) => i.origin === "natural");
  const badHeld = results.items.filter((i) => i.reference === "unsupported");
  const naturalBadHeld = badHeld.filter((i) => i.origin === "natural").length;
  const calls = all.packs.reduce((a, p) => a + p.calls, 0);
  const heldCalls = results.packs.reduce((a, p) => a + p.calls, 0);

  const out: string[] = [];
  out.push("# Can a voice agent be stopped from saying wrong things, without slowing the call down?", "");
  if (all.mock) out.push("> **MOCK DATA.** Offline stand-in models. These numbers test the pipeline and say nothing about real checkers.", "");

  // ---------------------------------------------------------------- Summary
  out.push(
    "## Summary",
    "",
    "AI phone agents sometimes state things that aren't true: a wrong fee, an invented policy. This study tested ways to check each sentence before the caller hears it.",
    "",
    "<!-- summary:start -->",
  );
  // The agent's own error rate among labeled natural sentences: the base rate a check works against.
  const labeled = naturalHeld.filter((i) => i.reference !== "uncertain").length;
  const errRate = labeled ? naturalBadHeld / labeled : NaN;
  if (pick) {
    out.push(
      `- **Fast and cheap enough.** ${name(pick.checker)} stopped ${pct(pick.caught.all.rate)} of wrong sentences, wrongly stopped ${pct(pick.falseBlock.rate)} of correct ones, and added ${Math.round(pick.firstAudio.p95)} ms of silence, at $${(pick.costPerCall * 1000).toFixed(2)} per 1,000 calls.`,
      ...(judges.length ? [`- **General AI models are too slow.** Checking every sentence with one added ${range(judges.map((m) => m.firstAudio.p95 / 1000), (x) => x.toFixed(1))} s of silence.`] : []),
      `- **Value on real mistakes is unproven.** The agent was already right ${pct(1 - errRate)} of the time. Of its ${naturalBadHeld} real mistakes, the check stopped ${pick.caught.natural.k}, and it wrongly held ${pick.falseBlock.k} correct sentences; most of the ${pct(pick.caught.all.rate)} comes from planted mistakes. Best aimed at costly claims (fees, refunds, promises).`,
      "",
    );
  } else {
    out.push("AI phone agents sometimes state things that aren't true. This study tested ways to check each sentence before the caller hears it; on this data, no approach met both the accuracy and speed bars.", "");
  }

  // ---------------------------------------------------------------- Problem
  out.push("<!-- summary:end -->", "");
  out.push(
    "## The problem",
    "",
    "Companies increasingly use AI voice agents to call customers: appointment reminders, overdue bills, membership offers. " +
      "The agent is a large language model (LLM) given a **knowledge pack** (the company's policies, prices and hours) and the customer's account details, and its words are turned into speech as they are generated.",
    "",
    "LLMs occasionally say things their sources don't support: a fee that doesn't exist, a discount nobody approved, a claim that something was already done. " +
      "In a chat window a reader might catch it; on a phone call the customer simply hears it, and it may be a promise the company now has to honor or a policy it has to walk back. " +
      "Instructions in the agent's prompt reduce this but can't guarantee it.",
    "",
    "The obvious fix is to **check each sentence against the knowledge pack before it is spoken**. The catch is time: every check adds silence, and on a call even half a second of extra silence feels broken. " +
      "A check that blocks too eagerly is also a problem, because every correct sentence it stops is replaced with \"let me have someone follow up\", which makes the agent useless.",
    "",
  );

  // ---------------------------------------------------------------- Hypothesis
  out.push(
    "## Hypothesis",
    "",
    "A pre-speech check is good enough for live calls if, on a scenario it was **not** tuned on, it stops most wrong sentences while staying inside two limits that were fixed before any results were seen:",
    "",
    `1. It wrongly stops at most **${pct(study.max_false_block_rate)}** of correct sentences.`,
    `2. It adds at most **${study.latency_budget_ms} ms** of silence before the agent starts speaking (measured on the slowest 5% of turns).`,
    "",
    "The approaches tested each bet on a different trade-off:",
    "",
    "- **Rules only:** plain code checks that every price, time and date mentioned appears in the knowledge pack. Bet: instant and free, but blind to anything that isn't a number.",
    "- **A small AI model on every sentence** (Gemini Flash-Lite, GPT-5.4 nano, Claude Haiku), asked \"is this supported?\". Bet: accurate, but possibly too slow.",
    "- **A decision model on every sentence** (Jev), which returns a single probability instead of writing text. Bet: accurate *and* fast.",
    "- **Rules, then a model:** rules first; only sentences that contain something checkable (a price, a policy, a claim that something was done) go to the model, while greetings and questions are spoken immediately. Bet: most of the accuracy for a fraction of the delay and cost.",
    "",
  );

  // ---------------------------------------------------------------- Experiment
  const plantsNum = results.items.filter((i) => i.origin === "planted-numeric" && i.reference === "unsupported").length;
  const plantsSem = results.items.filter((i) => i.origin === "planted-semantic" && i.reference === "unsupported").length;
  out.push(
    "## The experiment",
    "",
    `1. **Scenarios.** ${all.packs.length} made-up businesses, each with a knowledge pack, one customer's account details, and two kinds of caller question: ones the pack answers, and \"bait\" questions it deliberately doesn't, to tempt the agent into making something up: ${all.packs.map((p) => p.title).join("; ")}.`,
    `2. **Simulated calls.** The agent (${study.agent.model}) held ${calls} text-based phone calls with AI callers playing seven types of customer: cooperative, curious, the wrong person, wants to cancel, tries to read out a card number, haggling, upset. That produced ${naturalAll.length} agent sentences.`,
    `3. **An answer key.** Two other AI models, not among those being tested, independently judged every sentence as supported or not by the knowledge pack. Where they agreed, that became the answer; where they disagreed, the sentence was left out of the scoring.`,
    `4. **Known mistakes.** The agent rarely makes things up on its own, so known-wrong sentences were added on purpose: real agent sentences with a number changed (\"$15\" to \"$16\"), and with the meaning changed (\"can be paid over the phone\" when the pack says it can't).`,
    `5. **Every check on every sentence.** Each approach judged each sentence. Recorded: wrong sentences stopped, correct sentences wrongly stopped, the silence it would add before the agent speaks, and its cost.`,
    rec.tunePacks.length
      ? `6. **Tuning kept apart from scoring.** Prompts and settings were improved using ${tuneTitles.join(" and ")} only. All results below come from ${heldTitles.join(" and ")}, which no tuning ever saw: ${heldCalls} calls, ${naturalHeld.length} agent sentences, ${badHeld.length} wrong sentences to catch (${naturalBadHeld} the agent's own, ${plantsNum} with a changed number, ${plantsSem} with a changed meaning).`
      : `6. Results cover ${heldCalls} calls and ${badHeld.length} wrong sentences.`,
    "",
    `The winner is chosen by a fixed rule written before the results: among approaches inside both limits, the one that stops the most wrong sentences; if two aren't statistically different, the cheaper one.`,
    "",
  );

  // ---------------------------------------------------------------- Findings
  out.push("## Findings", "", "<!-- table:start -->");
  out.push(
    table(
      ["Approach", "Wrong stopped", "Correct wrongly stopped", "Added silence", "Cost / 1k calls", "Within limits?"],
      base.map((m) => [
        m.checker === pick?.checker ? `**${name(m.checker)}**` : name(m.checker),
        pct(m.caught.all.rate),
        pct(m.falseBlock.rate),
        `${Math.round(m.firstAudio.p95)} ms`,
        `$${(m.costPerCall * 1000).toFixed(2)}`,
        m.checker === "none" ? "—" : meets(m) ? "yes" : [m.falseBlock.rate > study.max_false_block_rate && "too strict", m.firstAudio.p95 > study.latency_budget_ms && "too slow"].filter(Boolean).join(", "),
      ]),
    ),
    "",
    `A model alone checks every sentence; "Rules →" sends it only sentences with something to check. Held-out scenario: ${badHeld.length} wrong, ${held.get("none")?.falseBlock.n ?? "?"} correct sentences. Silence = slowest 5% of turns.`,
    "<!-- table:end -->",
    "",
  );

  const findings: string[] = [];
  if (pick) {
    const share = Math.round(pick.modelShare * 100);
    findings.push(
      `**1. A pre-speech check can be fast and cheap enough for live calls.** ${name(pick.checker)} met both limits: it stopped ${pick.caught.all.k} of ${pick.caught.all.n} wrong sentences, wrongly stopped ${pick.falseBlock.k} of ${pick.falseBlock.n} correct ones, and added ${Math.round(pick.firstAudio.p95)} ms. ` +
        (spec.get(pick.checker)?.kind === "cascade" ? `Only ${share}% of sentences needed the model at all; the rest were greetings, questions and other sentences with nothing to check.` : ""),
    );
  }
  if (judges.length) {
    findings.push(
      `**2. General AI models are accurate enough but too slow.** Checking every sentence with ${judges.map((m) => name(m.checker)).join(", ")} stopped ${range(judges.map((m) => m.caught.all.rate), pct)} of wrong sentences, but added ${range(judges.map((m) => m.firstAudio.p95), (x) => `${Math.round(x)}`)} ms of silence, well over the ${study.latency_budget_ms} ms limit` +
        (judges.some((m) => m.falseBlock.rate > study.max_false_block_rate) ? `, and some wrongly stopped up to ${pct(Math.max(...judges.map((m) => m.falseBlock.rate)))} of correct sentences.` : "."),
    );
  }
  if (rules) {
    findings.push(
      `**3. Rules alone are free and instant, but half-blind.** They stopped ${pct(rules.caught.numeric.rate)} of wrong numbers and ${pct(rules.caught.semantic.rate)} of wrong meanings (${pct(rules.caught.all.rate)} overall). They are the right first layer, not the whole answer.`,
    );
  }
  if (decision) {
    findings.push(
      `**4. The decision model is what makes it fast.** Jev on every sentence added ${Math.round(decision.firstAudio.p95)} ms, against ${range(judges.map((m) => m.firstAudio.p95), (x) => `${Math.round(x)}`)} ms for the AI judges, with ${pct(decision.caught.all.rate)} of wrong sentences stopped. Putting rules in front of it ${pick && spec.get(pick.checker)?.kind === "cascade" ? `cut its cost to $${(pick.costPerCall * 1000).toFixed(2)} per 1,000 calls` : "reduces cost further"}.`,
    );
  }
  // Tuning: what the revised prompt and fitted cutoffs did, on the tuning scenario vs. held out.
  const pairs = all.checkers
    .filter((c) => isVariant(c) && rec.tuneMetrics.length)
    .map((c) => ({ c, b: baseName(c.name) }))
    .filter(({ b }) => held.has(b) && tuned.has(b));
  if (pairs.length) {
    const avg = (map: Map<string, CheckerMetrics>, f: (c: string) => boolean, get: (m: CheckerMetrics) => number) => {
      const ds = pairs.filter(({ c }) => f(c.name)).map(({ c, b }) => get(map.get(c.name)!) - get(map.get(b)!));
      return ds.length ? ds.reduce((a, x) => a + x, 0) / ds.length : NaN;
    };
    const blocked = (m: CheckerMetrics) => m.falseBlock.rate;
    const caught = (m: CheckerMetrics) => m.caught.all.rate;
    const prompt = (n: string) => /-v2/.test(n) && !n.includes("calibrated");
    const cutoff = (n: string) => n.includes("calibrated") && !/-v2/.test(n);
    const signed = (d: number) => `${d <= 0 ? "−" : "+"}${pts(Math.abs(d))}`;
    findings.push(
      `**5. Tuning helped less than it appeared to.** Two improvements were tried on the tuning scenario and then checked on the held-out one. ` +
        `A revised checking prompt changed the share of correct sentences wrongly stopped by ${signed(avg(tuned, prompt, blocked))} on the tuning scenario but only ${signed(avg(held, prompt, blocked))} on held-out data. ` +
        `A tuned confidence cutoff for Jev, meant to catch more while staying under the ${pct(study.max_false_block_rate)} limit, changed errors caught by ${signed(avg(held, cutoff, caught))} on held-out data ` +
        `but wrongly stopped correct sentences ${signed(avg(held, cutoff, blocked))}, pushing it over the limit. ` +
        `Improvements measured on the data used to make them overstate what they deliver on new data, which is why the winner is chosen on held-out data only.`,
    );
  }
  if (pick) {
    const per100 = (n: number) => (heldCalls ? ((n / heldCalls) * 100).toFixed(0) : "n/a");
    const none = held.get("none");
    findings.push(
      `**6. On the agent's real mistakes, the benefit is unproven.** Of the agent's own ${pick.caught.natural.n} mistakes in the held-out calls, ${name(pick.checker)} stopped ${pick.caught.natural.k}; ` +
        `its high overall rate comes mostly from planted mistakes, especially changed numbers. Per 100 calls, that means about ${per100(pick.caught.natural.n - pick.caught.natural.k)} of the agent's own wrong sentences would still be heard (against ${none ? per100(none.caught.natural.n) : "n/a"} with no check), ` +
        `while about ${per100(pick.falseBlock.k)} correct sentences would be replaced with a follow-up offer. With so few real mistakes, those per-call figures are rough.`,
    );
  }
  out.push(...findings.flatMap((f) => [f, ""]));

  // ---------------------------------------------------------------- Limitations
  out.push(
    "## Limitations",
    "",
    "- **Simulated calls, in text.** The callers are AI models playing roles, and nothing passes through real speech recognition or a phone line. Delays are measured API times plus a model of speaking speed, not timings from live calls.",
    `- **Few real mistakes.** The agent made only ${naturalBadHeld} wrong statement${naturalBadHeld === 1 ? "" : "s"} of its own in the held-out scenario, so most of the wrong sentences tested were planted. The results say what each check *can* catch, not how often agents err.`,
    "- **An AI answer key.** \"Right\" and \"wrong\" were judged by two AI models, not people; sentences they disagreed on were left out, which removes some of the hardest cases.",
    `- **${heldTitles.length === 1 ? "One" : heldTitles.length} held-out scenario${heldTitles.length === 1 ? "" : "s"}, with a short knowledge pack.** Longer rulebooks with more conditions (offers, eligibility, cancellation steps) give a checker more chances to wrongly stop correct sentences.`,
    "",
  );

  // ---------------------------------------------------------------- Next steps
  out.push(
    "## Next steps",
    "",
    "1. **Measure it on real mistakes.** Collect many more of the agent's own errors (a weaker agent model, longer knowledge packs, more calls) so the catch rate on real mistakes isn't resting on a handful.",
    "2. **Check only what's costly.** Block only high-stakes claims (prices, fees, refunds, promises, completed actions) and let everything else through, which should cut wrongly stopped sentences where they matter least.",
    "3. **Real calls.** Put the check into a live voice pipeline and measure the added silence on actual phone audio.",
    "4. **Human-reviewed answers.** Have people review the AI-labeled sentences, starting with the disagreements.",
    "5. **More, and harder, scenarios.** Add held-out businesses with longer rulebooks, where over-blocking is the bigger risk.",
    "",
    "---",
    "",
  );

  out.push(renderAppendix(all, rec));
  return out.join("\n");
}

function renderAppendix(all: Results, rec: Recommendation): string {
  const { study } = all;
  // Everything below the setup describes held-out scenarios; tuning scenarios get their own section.
  const results = rec.testPacks.length ? restrict(all, rec.testPacks) : all;
  const out: string[] = [];
  out.push("## Appendix: full technical results", "");
  out.push(
    "For readers who want to check the details. Checkers appear by their config names; the key below maps them to the plain names used above.",
    "",
    table(["Config name", "Plain name"], all.checkers.map((c) => [`\`${c.name}\``, plainName(c)])),
    "",
    `**One-line summary (generated by fixed rules):** ${rec.finding}`,
    "",
  );

  const natural = results.items.filter((i) => i.origin === "natural");
  const count = (ref: string) => natural.filter((i) => i.reference === ref).length;
  const reviewed = natural.filter((i) => i.labelSource === "review");
  const reviewers = [...new Set(reviewed.map((i) => i.reviewer ?? "unnamed"))];
  out.push("### Setup", "");
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

  out.push("### Results", "");
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

  out.push("### Picks", "");
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
  out.push("### What callers would hear, per 100 calls", "");
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
    out.push("### By scenario", "");
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
    out.push("### Tuning scenario (not used for picks)", "");
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

  out.push("### After-call audit (calls as simulated, no gate)", "");
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
    out.push("### Natural errors, and who caught them", "");
    for (const ex of examples) {
      const by = results.verdicts.filter((v) => v.pack === ex.pack && v.id === ex.id && !v.pass).map((v) => `\`${v.checker}\``);
      out.push(`- "${ex.sentence}" (${ex.pack}). Caught by: ${by.join(", ") || "none"}.`);
    }
    out.push("");
  }

  out.push(
    "### Technical caveats",
    "",
    "- Simulated callers are LLMs following personas, not people. Real calls add speech-recognition errors and barge-in, which this replay doesn't model.",
    "- Delay is the measured API time per check from one location, under this run's concurrency, plus a timing model of streamed speech; it is not measured on a phone line.",
    "- Planted errors show what each checker can catch, not how often agents make that error.",
    "- Reference labels come from two models; disagreements are excluded, which removes the hardest cases from the denominators.",
    "",
  );
  return out.join("\n");
}

/** The repo README's results block: the report's plain summary and results table, plus a link. */
export function readmeBlock(report: string, link: string): string {
  const section = (name: string) => report.split(`<!-- ${name}:start -->`)[1]?.split(`<!-- ${name}:end -->`)[0]?.trim() ?? "";
  return [section("summary"), section("table"), `**[Full report](${link})**: method, all findings, limitations, next steps.`]
    .filter(Boolean)
    .join("\n\n");
}

# Can a voice agent be stopped from saying wrong things, without slowing the call down?

## Summary

AI phone agents sometimes state things that aren't true: a wrong fee, an invented policy. This study tested ways to check each sentence before the caller hears it.

<!-- summary:start -->
- **Fast and cheap enough.** Rules → Jev stopped 90% of wrong sentences, wrongly stopped 2.6% of correct ones, and added 161 ms of silence, at $0.22 per 1,000 calls.
- **General AI models are too slow.** Checking every sentence with one added 0.7–1.4 s of silence.
- **Value on real mistakes is unproven.** The agent was already right 97% of the time. Of its 4 real mistakes, the check stopped 1, and it wrongly held 4 correct sentences; most of the 90% comes from planted mistakes. Best aimed at costly claims (fees, refunds, promises).

<!-- summary:end -->

## The problem

Companies increasingly use AI voice agents to call customers: appointment reminders, overdue bills, membership offers. The agent is a large language model (LLM) given a **knowledge pack** (the company's policies, prices and hours) and the customer's account details, and its words are turned into speech as they are generated.

LLMs occasionally say things their sources don't support: a fee that doesn't exist, a discount nobody approved, a claim that something was already done. In a chat window a reader might catch it; on a phone call the customer simply hears it, and it may be a promise the company now has to honor or a policy it has to walk back. Instructions in the agent's prompt reduce this but can't guarantee it.

The obvious fix is to **check each sentence against the knowledge pack before it is spoken**. The catch is time: every check adds silence, and on a call even half a second of extra silence feels broken. A check that blocks too eagerly is also a problem, because every correct sentence it stops is replaced with "let me have someone follow up", which makes the agent useless.

## Hypothesis

A pre-speech check is good enough for live calls if, on a scenario it was **not** tuned on, it stops most wrong sentences while staying inside two limits that were fixed before any results were seen:

1. It wrongly stops at most **5.0%** of correct sentences.
2. It adds at most **300 ms** of silence before the agent starts speaking (measured on the slowest 5% of turns).

The approaches tested each bet on a different trade-off:

- **Rules only:** plain code checks that every price, time and date mentioned appears in the knowledge pack. Bet: instant and free, but blind to anything that isn't a number.
- **A small AI model on every sentence** (Gemini Flash-Lite, GPT-5.4 nano, Claude Haiku), asked "is this supported?". Bet: accurate, but possibly too slow.
- **A decision model on every sentence** (Jev), which returns a single probability instead of writing text. Bet: accurate *and* fast.
- **Rules, then a model:** rules first; only sentences that contain something checkable (a price, a policy, a claim that something was done) go to the model, while greetings and questions are spoken immediately. Bet: most of the accuracy for a fraction of the delay and cost.

## The experiment

1. **Scenarios.** 2 made-up businesses, each with a knowledge pack, one customer's account details, and two kinds of caller question: ones the pack answers, and "bait" questions it deliberately doesn't, to tempt the agent into making something up: Brightside Dental (appointment reminder); Northwind Fiber (past-due bill).
2. **Simulated calls.** The agent (openai/gpt-5.4-mini) held 42 text-based phone calls with AI callers playing seven types of customer: cooperative, curious, the wrong person, wants to cancel, tries to read out a card number, haggling, upset. That produced 326 agent sentences.
3. **An answer key.** Two other AI models, not among those being tested, independently judged every sentence as supported or not by the knowledge pack. Where they agreed, that became the answer; where they disagreed, the sentence was left out of the scoring.
4. **Known mistakes.** The agent rarely makes things up on its own, so known-wrong sentences were added on purpose: real agent sentences with a number changed ("$15" to "$16"), and with the meaning changed ("can be paid over the phone" when the pack says it can't).
5. **Every check on every sentence.** Each approach judged each sentence. Recorded: wrong sentences stopped, correct sentences wrongly stopped, the silence it would add before the agent speaks, and its cost.
6. **Tuning kept apart from scoring.** Prompts and settings were improved using Brightside Dental (appointment reminder) only. All results below come from Northwind Fiber (past-due bill), which no tuning ever saw: 21 calls, 175 agent sentences, 42 wrong sentences to catch (4 the agent's own, 25 with a changed number, 13 with a changed meaning).

The winner is chosen by a fixed rule written before the results: among approaches inside both limits, the one that stops the most wrong sentences; if two aren't statistically different, the cheaper one.

## Findings

<!-- table:start -->
| Approach | Wrong stopped | Correct wrongly stopped | Added silence | Cost / 1k calls | Within limits? |
|---|---|---|---|---|---|
| No check | 0% | 0% | 0 ms | $0.00 | — |
| Rules only | 62% | 0.6% | 0 ms | $0.00 | yes |
| Gemini Flash-Lite | 81% | 1.3% | 1018 ms | $2.12 | too slow |
| GPT-5.4 nano | 93% | 15% | 697 ms | $2.08 | too strict, too slow |
| Claude Haiku | 88% | 9.7% | 1378 ms | $1.27 | too strict, too slow |
| Jev | 86% | 4.5% | 177 ms | $0.43 | yes |
| Rules → Gemini Flash-Lite | 88% | 0.6% | 828 ms | $1.06 | too slow |
| **Rules → Jev** | 90% | 2.6% | 161 ms | $0.22 | yes |

A model alone checks every sentence; "Rules →" sends it only sentences with something to check. Held-out scenario: 42 wrong, 154 correct sentences. Silence = slowest 5% of turns.
<!-- table:end -->

**1. A pre-speech check can be fast and cheap enough for live calls.** Rules → Jev met both limits: it stopped 38 of 42 wrong sentences, wrongly stopped 4 of 154 correct ones, and added 161 ms. Only 48% of sentences needed the model at all; the rest were greetings, questions and other sentences with nothing to check.

**2. General AI models are accurate enough but too slow.** Checking every sentence with Gemini Flash-Lite, GPT-5.4 nano, Claude Haiku stopped 81%–93% of wrong sentences, but added 697–1378 ms of silence, well over the 300 ms limit, and some wrongly stopped up to 15% of correct sentences.

**3. Rules alone are free and instant, but half-blind.** They stopped 100% of wrong numbers and 0% of wrong meanings (62% overall). They are the right first layer, not the whole answer.

**4. The decision model is what makes it fast.** Jev on every sentence added 177 ms, against 697–1378 ms for the AI judges, with 86% of wrong sentences stopped. Putting rules in front of it cut its cost to $0.22 per 1,000 calls.

**5. Tuning helped less than it appeared to.** Two improvements were tried on the tuning scenario and then checked on the held-out one. A revised checking prompt changed the share of correct sentences wrongly stopped by −2.6 points on the tuning scenario but only −1.5 points on held-out data. A tuned confidence cutoff for Jev, meant to catch more while staying under the 5.0% limit, changed errors caught by +2.4 points on held-out data but wrongly stopped correct sentences +6.5 points, pushing it over the limit. Improvements measured on the data used to make them overstate what they deliver on new data, which is why the winner is chosen on held-out data only.

**6. On the agent's real mistakes, the benefit is unproven.** Of the agent's own 4 mistakes in the held-out calls, Rules → Jev stopped 1; its high overall rate comes mostly from planted mistakes, especially changed numbers. Per 100 calls, that means about 14 of the agent's own wrong sentences would still be heard (against 19 with no check), while about 19 correct sentences would be replaced with a follow-up offer. With so few real mistakes, those per-call figures are rough.

## Limitations

- **Simulated calls, in text.** The callers are AI models playing roles, and nothing passes through real speech recognition or a phone line. Delays are measured API times plus a model of speaking speed, not timings from live calls.
- **Few real mistakes.** The agent made only 4 wrong statements of its own in the held-out scenario, so most of the wrong sentences tested were planted. The results say what each check *can* catch, not how often agents err.
- **An AI answer key.** "Right" and "wrong" were judged by two AI models, not people; sentences they disagreed on were left out, which removes some of the hardest cases.
- **One held-out scenario, with a short knowledge pack.** Longer rulebooks with more conditions (offers, eligibility, cancellation steps) give a checker more chances to wrongly stop correct sentences.

## Next steps

1. **Measure it on real mistakes.** Collect many more of the agent's own errors (a weaker agent model, longer knowledge packs, more calls) so the catch rate on real mistakes isn't resting on a handful.
2. **Check only what's costly.** Block only high-stakes claims (prices, fees, refunds, promises, completed actions) and let everything else through, which should cut wrongly stopped sentences where they matter least.
3. **Real calls.** Put the check into a live voice pipeline and measure the added silence on actual phone audio.
4. **Human-reviewed answers.** Have people review the AI-labeled sentences, starting with the disagreements.
5. **More, and harder, scenarios.** Add held-out businesses with longer rulebooks, where over-blocking is the bigger risk.

---

## Appendix: full technical results

For readers who want to check the details. Checkers appear by their config names; the key below maps them to the plain names used above.

| Config name | Plain name |
|---|---|
| `none` | No check |
| `deterministic` | Rules only |
| `flash-lite` | Gemini Flash-Lite |
| `gpt-5.4-nano` | GPT-5.4 nano |
| `haiku-5.5` | Claude Haiku |
| `jev-1.14` | Jev |
| `jev-1.14-calibrated` | Jev (tuned cutoff) |
| `cascade-flash-lite` | Rules → Gemini Flash-Lite |
| `cascade-jev` | Rules → Jev |
| `cascade-jev-calibrated` | Rules → Jev (tuned cutoff) |
| `flash-lite-v2` | Gemini Flash-Lite (revised prompt) |
| `gpt-5.4-nano-v2` | GPT-5.4 nano (revised prompt) |
| `haiku-5.5-v2` | Claude Haiku (revised prompt) |
| `jev-1.14-v2` | Jev (revised prompt) |
| `jev-1.14-v2-calibrated` | Jev (revised prompt, tuned cutoff) |
| `cascade-flash-lite-v2` | Rules → Gemini Flash-Lite (revised prompt) |
| `cascade-jev-v2` | Rules → Jev (revised prompt) |
| `cascade-jev-v2-calibrated` | Rules → Jev (revised prompt, tuned cutoff) |

**One-line summary (generated by fixed rules):** On 42 unsupported sentences (4 natural, 38 planted) across 1 held-out scenario, cascade-jev caught 90% while blocking 2.6% of correct sentences, adding 161 ms p95 before the first word at $0.22 per 1,000 calls. Ignoring the limits, cascade-jev-calibrated caught the most (93%), not a significant difference.

### Setup

- Run: 2026-10-29T18:11:07.063Z. Agent `openai/gpt-5.4-mini`, simulated callers `google/gemini-3.1-flash-lite`, planted semantic errors written by `openai/gpt-5.4-mini`.
- Scenarios: Brightside Dental (appointment reminder) (21 calls, tuning); Northwind Fiber (past-due bill) (21 calls).
- 175 natural agent sentences. Reference labels from two models that are not contenders (`qwen/qwen3-30b-a3b-instruct-2507`, `meta-llama/llama-3.3-70b-instruct`): 154 supported, 4 unsupported, 17 uncertain (they disagreed; excluded from rates). 0 overridden by review. These are model labels, not human ground truth.
- 46 planted errors: 25 changed numbers (checked mechanically against the sources) and 21 changed meanings written by a model, of which 8 were excluded because both labelers found the rewrite supported.
- Limits fixed before the run: at most 5.0% of correct sentences blocked; at most 300 ms p95 added before the agent's first word. Speech assumed at 2.7 words per second.
- **Tuning vs. held out.** Prompts and cutoffs were tuned on brightside-dental only. Every number below is from the held-out scenario (northwind-fiber); tuning results are in their own section.
- `jev-1.14-calibrated` cutoff: P(supported) ≥ 0.7, fitted on 133 correct sentences from brightside-dental (false blocks there: 4.5%).
- `jev-1.14-v2-calibrated` cutoff: P(supported) ≥ 0.8, fitted on 133 correct sentences from brightside-dental (false blocks there: 4.5%).
- Spend on uncached requests in this run: $0.0507.

### Results

| Checker | Caught (all) | Natural errors | Planted: numbers | Planted: meaning | Correct sentences blocked | Delay before first word p50 / p95 (ms) | Mid-turn stall (ms) | Needed a model | $ / 1k calls | Errors |
|---|---|---|---|---|---|---|---|---|---|---|
| `none` | 0% (0/42; 0%–8.4%) | 0% (0/4) | 0% (0/25) | 0% (0/13) | 0% (0/154; 0.0%–2.4%) | 0 / 0 | 0 | 0% | 0.00 | 0 |
| `deterministic` | 62% (26/42; 47%–75%) | 25% (1/4) | 100% (25/25) | 0% (0/13) | 0.6% (1/154; 0.1%–3.6%) | 0 / 0 | 0 | 0% | 0.00 | 0 |
| `flash-lite` | 81% (34/42; 67%–90%) | 0% (0/4) | 92% (23/25) | 85% (11/13) | 1.3% (2/154; 0.4%–4.6%) | 665 / 1018 | 120 | 100% | 2.12 | 0 |
| `gpt-5.4-nano` | 93% (39/42; 81%–98%) | 50% (2/4) | 100% (25/25) | 92% (12/13) | 15% (23/154; 10%–21%) | 430 / 697 | 93 | 100% | 2.08 | 0 |
| `haiku-5.5` | 88% (37/42; 75%–95%) | 25% (1/4) | 96% (24/25) | 92% (12/13) | 9.7% (15/154; 6.0%–15%) | 1096 / 1378 | 0 | 100% | 1.27 | 1 |
| `jev-1.14` | 86% (36/42; 72%–93%) | 0% (0/4) | 96% (24/25) | 92% (12/13) | 4.5% (7/154; 2.2%–9.1%) | 136 / 177 | 0 | 100% | 0.43 | 0 |
| `jev-1.14-calibrated` | 88% (37/42; 75%–95%) | 25% (1/4) | 96% (24/25) | 92% (12/13) | 13% (20/154; 8.6%–19%) | 136 / 177 | 0 | 100% | 0.43 | 0 |
| `cascade-flash-lite` | 88% (37/42; 75%–95%) | 25% (1/4) | 100% (25/25) | 85% (11/13) | 0.6% (1/154; 0.1%–3.6%) | 0 / 828 | 10 | 48% | 1.06 | 0 |
| `cascade-jev` | 90% (38/42; 78%–96%) | 25% (1/4) | 100% (25/25) | 92% (12/13) | 2.6% (4/154; 1.0%–6.5%) | 0 / 161 | 0 | 48% | 0.22 | 0 |
| `cascade-jev-calibrated` | 93% (39/42; 81%–98%) | 50% (2/4) | 100% (25/25) | 92% (12/13) | 7.1% (11/154; 4.0%–12%) | 0 / 161 | 0 | 48% | 0.22 | 0 |
| `flash-lite-v2` | 81% (34/42; 67%–90%) | 0% (0/4) | 92% (23/25) | 85% (11/13) | 2.6% (4/154; 1.0%–6.5%) | 718 / 1590 | 0 | 100% | 2.48 | 0 |
| `gpt-5.4-nano-v2` | 90% (38/42; 78%–96%) | 25% (1/4) | 100% (25/25) | 92% (12/13) | 10% (16/154; 6.5%–16%) | 421 / 699 | 0 | 100% | 2.40 | 3 |
| `haiku-5.5-v2` | 90% (38/42; 78%–96%) | 50% (2/4) | 100% (25/25) | 85% (11/13) | 6.5% (10/154; 3.6%–12%) | 889 / 1404 | 0 | 100% | 1.50 | 0 |
| `jev-1.14-v2` | 86% (36/42; 72%–93%) | 0% (0/4) | 96% (24/25) | 92% (12/13) | 1.9% (3/154; 0.7%–5.6%) | 145 / 188 | 0 | 100% | 0.51 | 0 |
| `jev-1.14-v2-calibrated` | 90% (38/42; 78%–96%) | 25% (1/4) | 100% (25/25) | 92% (12/13) | 9.7% (15/154; 6.0%–15%) | 145 / 188 | 0 | 100% | 0.51 | 0 |
| `cascade-flash-lite-v2` | 88% (37/42; 75%–95%) | 25% (1/4) | 100% (25/25) | 85% (11/13) | 1.3% (2/154; 0.4%–4.6%) | 0 / 932 | 0 | 48% | 1.24 | 0 |
| `cascade-jev-v2` | 90% (38/42; 78%–96%) | 25% (1/4) | 100% (25/25) | 92% (12/13) | 1.9% (3/154; 0.7%–5.6%) | 0 / 170 | 0 | 48% | 0.25 | 0 |
| `cascade-jev-v2-calibrated` | 93% (39/42; 81%–98%) | 50% (2/4) | 100% (25/25) | 92% (12/13) | 5.2% (8/154; 2.7%–9.9%) | 0 / 170 | 0 | 48% | 0.25 | 0 |

Caught = unsupported sentences the checker would have stopped. Rates show the 95% Wilson interval. A checker error blocks the sentence and counts as a block.

### Picks

- **Within both limits: `cascade-jev`.** Leader on catches: `cascade-jev`. Statistically tied with the leader (McNemar p ≥ 0.05): `cascade-jev` (p=1.00), `cascade-jev-v2` (p=1.00), `jev-1.14` (p=0.50), `jev-1.14-v2` (p=0.50); the cheapest of those is picked.
- **Most accurate, ignoring the limits: `cascade-jev-calibrated`.** Not significantly different from it: `cascade-jev-v2-calibrated` (p=1.00), `gpt-5.4-nano` (p=1.00), `cascade-jev` (p=1.00), `cascade-jev-v2` (p=1.00), `jev-1.14-v2-calibrated` (p=1.00), `haiku-5.5-v2` (p=1.00), `gpt-5.4-nano-v2` (p=1.00), `jev-1.14-calibrated` (p=0.50), `cascade-flash-lite` (p=0.50), `cascade-flash-lite-v2` (p=0.50), `haiku-5.5` (p=0.50), `jev-1.14` (p=0.25), `jev-1.14-v2` (p=0.25), `flash-lite` (p=0.06), `flash-lite-v2` (p=0.06).
- `flash-lite` is outside the limits: adds 1018 ms p95 before the first word.
- `gpt-5.4-nano` is outside the limits: blocks 15% of correct sentences; adds 697 ms p95 before the first word.
- `haiku-5.5` is outside the limits: blocks 9.7% of correct sentences; adds 1378 ms p95 before the first word.
- `jev-1.14-calibrated` is outside the limits: blocks 13% of correct sentences.
- `cascade-flash-lite` is outside the limits: adds 828 ms p95 before the first word.
- `cascade-jev-calibrated` is outside the limits: blocks 7.1% of correct sentences.
- `flash-lite-v2` is outside the limits: adds 1590 ms p95 before the first word.
- `gpt-5.4-nano-v2` is outside the limits: blocks 10% of correct sentences; adds 699 ms p95 before the first word.
- `haiku-5.5-v2` is outside the limits: blocks 6.5% of correct sentences; adds 1404 ms p95 before the first word.
- `jev-1.14-v2-calibrated` is outside the limits: blocks 9.7% of correct sentences.
- `cascade-flash-lite-v2` is outside the limits: adds 932 ms p95 before the first word.
- `cascade-jev-v2-calibrated` is outside the limits: blocks 5.2% of correct sentences.

### What callers would hear, per 100 calls

Natural sentences only. *Hold* speaks a sentence only after it passes and replaces a blocked one with the fallback line. *Speak then correct* adds no delay, but every error is heard first and caught ones are corrected on the next turn.

| Checker | Hold: errors heard | Hold: needless fallbacks | Speak then correct: errors heard | …of which corrected | …needless corrections |
|---|---|---|---|---|---|
| `none` | 19.0 | 0.0 | 19.0 | 0.0 | 0.0 |
| `deterministic` | 14.3 | 4.8 | 19.0 | 4.8 | 4.8 |
| `flash-lite` | 19.0 | 9.5 | 19.0 | 0.0 | 9.5 |
| `gpt-5.4-nano` | 9.5 | 109.5 | 19.0 | 9.5 | 109.5 |
| `haiku-5.5` | 14.3 | 71.4 | 19.0 | 4.8 | 71.4 |
| `jev-1.14` | 19.0 | 33.3 | 19.0 | 0.0 | 33.3 |
| `jev-1.14-calibrated` | 14.3 | 95.2 | 19.0 | 4.8 | 95.2 |
| `cascade-flash-lite` | 14.3 | 4.8 | 19.0 | 4.8 | 4.8 |
| `cascade-jev` | 14.3 | 19.0 | 19.0 | 4.8 | 19.0 |
| `cascade-jev-calibrated` | 9.5 | 52.4 | 19.0 | 9.5 | 52.4 |
| `flash-lite-v2` | 19.0 | 19.0 | 19.0 | 0.0 | 19.0 |
| `gpt-5.4-nano-v2` | 14.3 | 76.2 | 19.0 | 4.8 | 76.2 |
| `haiku-5.5-v2` | 9.5 | 47.6 | 19.0 | 9.5 | 47.6 |
| `jev-1.14-v2` | 19.0 | 14.3 | 19.0 | 0.0 | 14.3 |
| `jev-1.14-v2-calibrated` | 14.3 | 71.4 | 19.0 | 4.8 | 71.4 |
| `cascade-flash-lite-v2` | 14.3 | 9.5 | 19.0 | 4.8 | 9.5 |
| `cascade-jev-v2` | 14.3 | 14.3 | 19.0 | 4.8 | 14.3 |
| `cascade-jev-v2-calibrated` | 9.5 | 38.1 | 19.0 | 9.5 | 38.1 |

### Tuning scenario (not used for picks)

Prompts were revised and cutoffs fitted while looking at these results, so they flatter the tuned checkers. Compare with the held-out numbers above.

| Checker | Caught (all) | Correct sentences blocked | Delay before first word p95 (ms) |
|---|---|---|---|
| `none` | 0% (0/45; 0%–7.9%) | 0% (0/133; 0%–2.8%) | 0 |
| `deterministic` | 67% (30/45; 52%–79%) | 0% (0/133; 0%–2.8%) | 0 |
| `flash-lite` | 96% (43/45; 85%–99%) | 2.3% (3/133; 0.8%–6.4%) | 829 |
| `gpt-5.4-nano` | 93% (42/45; 82%–98%) | 14% (19/133; 9.3%–21%) | 1065 |
| `haiku-5.5` | 96% (43/45; 85%–99%) | 4.5% (6/133; 2.1%–9.5%) | 1627 |
| `jev-1.14` | 91% (41/45; 79%–96%) | 2.3% (3/133; 0.8%–6.4%) | 181 |
| `jev-1.14-calibrated` | 93% (42/45; 82%–98%) | 4.5% (6/133; 2.1%–9.5%) | 181 |
| `cascade-flash-lite` | 96% (43/45; 85%–99%) | 0% (0/133; 0%–2.8%) | 820 |
| `cascade-jev` | 89% (40/45; 77%–95%) | 0.8% (1/133; 0.1%–4.1%) | 161 |
| `cascade-jev-calibrated` | 91% (41/45; 79%–96%) | 0.8% (1/133; 0.1%–4.1%) | 161 |
| `flash-lite-v2` | 96% (43/45; 85%–99%) | 0.8% (1/133; 0.1%–4.1%) | 889 |
| `gpt-5.4-nano-v2` | 96% (43/45; 85%–99%) | 3.0% (4/133; 1.2%–7.5%) | 755 |
| `haiku-5.5-v2` | 96% (43/45; 85%–99%) | 2.3% (3/133; 0.8%–6.4%) | 1407 |
| `jev-1.14-v2` | 93% (42/45; 82%–98%) | 1.5% (2/133; 0.4%–5.3%) | 195 |
| `jev-1.14-v2-calibrated` | 100% (45/45; 92%–100%) | 4.5% (6/133; 2.1%–9.5%) | 195 |
| `cascade-flash-lite-v2` | 96% (43/45; 85%–99%) | 0% (0/133; 0%–2.8%) | 713 |
| `cascade-jev-v2` | 91% (41/45; 79%–96%) | 0.8% (1/133; 0.1%–4.1%) | 160 |
| `cascade-jev-v2-calibrated` | 98% (44/45; 88%–100%) | 1.5% (2/133; 0.4%–5.3%) | 160 |

### After-call audit (calls as simulated, no gate)

| Scenario | Calls | amount-not-in-sources | callback-promised-not-logged | card-number-in-transcript |
|---|---|---|---|---|
| Brightside Dental (appointment reminder) | 21 | 0 | 3 | 3 |
| Northwind Fiber (past-due bill) | 21 | 2 | 2 | 3 |

### Natural errors, and who caught them

- "I’m calling because your $65 bill was due on October 5 and a $10 late fee was added on October 12, so the past-due balance is now $75." (northwind-fiber). Caught by: `deterministic`, `haiku-5.5`, `cascade-flash-lite`, `cascade-jev`, `cascade-jev-calibrated`, `haiku-5.5-v2`, `cascade-flash-lite-v2`, `cascade-jev-v2`, `cascade-jev-v2-calibrated`.
- "I’ve logged it for staff follow-up, and someone will contact you after they review it." (northwind-fiber). Caught by: `gpt-5.4-nano`, `jev-1.14-calibrated`, `cascade-jev-calibrated`, `gpt-5.4-nano-v2`, `jev-1.14-v2-calibrated`, `cascade-jev-v2-calibrated`.
- "That’s reviewed by staff, and if approved they’ll confirm it by email within 2 business days." (northwind-fiber). Caught by: `gpt-5.4-nano`, `haiku-5.5-v2`.
- "Billing will confirm by email within 2 business days, and since the bill is still unpaid, service would be suspended on November 4 if nothing changes before then." (northwind-fiber). Caught by: none.

### Technical caveats

- Simulated callers are LLMs following personas, not people. Real calls add speech-recognition errors and barge-in, which this replay doesn't model.
- Delay is the measured API time per check from one location, under this run's concurrency, plus a timing model of streamed speech; it is not measured on a phone line.
- Planted errors show what each checker can catch, not how often agents make that error.
- Reference labels come from two models; disagreements are excluded, which removes the hardest cases from the denominators.

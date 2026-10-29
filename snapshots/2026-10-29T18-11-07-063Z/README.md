# Speech gate study report

**Finding:** On 42 unsupported sentences (4 natural, 38 planted) across 1 held-out scenario, cascade-jev caught 90% while blocking 2.6% of correct sentences, adding 161 ms p95 before the first word at $0.22 per 1,000 calls. Ignoring the limits, cascade-jev-calibrated caught the most (93%), not a significant difference.

## Setup

- Run: 2026-10-29T18:11:07.063Z. Agent `openai/gpt-5.4-mini`, simulated callers `google/gemini-3.1-flash-lite`, planted semantic errors written by `openai/gpt-5.4-mini`.
- Scenarios: Brightside Dental (appointment reminder) (21 calls, tuning); Northwind Fiber (past-due bill) (21 calls).
- 175 natural agent sentences. Reference labels from two models that are not contenders (`qwen/qwen3-30b-a3b-instruct-2507`, `meta-llama/llama-3.3-70b-instruct`): 154 supported, 4 unsupported, 17 uncertain (they disagreed; excluded from rates). 0 overridden by review. These are model labels, not human ground truth.
- 46 planted errors: 25 changed numbers (checked mechanically against the sources) and 21 changed meanings written by a model, of which 8 were excluded because both labelers found the rewrite supported.
- Limits fixed before the run: at most 5.0% of correct sentences blocked; at most 300 ms p95 added before the agent's first word. Speech assumed at 2.7 words per second.
- **Tuning vs. held out.** Prompts and cutoffs were tuned on brightside-dental only. Every number below is from the held-out scenario (northwind-fiber); tuning results are in their own section.
- `jev-1.14-calibrated` cutoff: P(supported) ≥ 0.7, fitted on 133 correct sentences from brightside-dental (false blocks there: 4.5%).
- `jev-1.14-v2-calibrated` cutoff: P(supported) ≥ 0.8, fitted on 133 correct sentences from brightside-dental (false blocks there: 4.5%).
- Spend on uncached requests in this run: $0.0507.

## Results

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

## Picks

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

## What callers would hear, per 100 calls

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

## Tuning scenario (not used for picks)

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

## After-call audit (calls as simulated, no gate)

| Scenario | Calls | amount-not-in-sources | callback-promised-not-logged | card-number-in-transcript |
|---|---|---|---|---|
| Brightside Dental (appointment reminder) | 21 | 0 | 3 | 3 |
| Northwind Fiber (past-due bill) | 21 | 2 | 2 | 3 |

## Natural errors, and who caught them

- "I’m calling because your $65 bill was due on October 5 and a $10 late fee was added on October 12, so the past-due balance is now $75." (northwind-fiber). Caught by: `deterministic`, `haiku-5.5`, `cascade-flash-lite`, `cascade-jev`, `cascade-jev-calibrated`, `haiku-5.5-v2`, `cascade-flash-lite-v2`, `cascade-jev-v2`, `cascade-jev-v2-calibrated`.
- "I’ve logged it for staff follow-up, and someone will contact you after they review it." (northwind-fiber). Caught by: `gpt-5.4-nano`, `jev-1.14-calibrated`, `cascade-jev-calibrated`, `gpt-5.4-nano-v2`, `jev-1.14-v2-calibrated`, `cascade-jev-v2-calibrated`.
- "That’s reviewed by staff, and if approved they’ll confirm it by email within 2 business days." (northwind-fiber). Caught by: `gpt-5.4-nano`, `haiku-5.5-v2`.
- "Billing will confirm by email within 2 business days, and since the bill is still unpaid, service would be suspended on November 4 if nothing changes before then." (northwind-fiber). Caught by: none.

## Caveats

- Simulated callers are LLMs following personas, not people. Real calls add speech-recognition errors and barge-in, which this replay doesn't model.
- Delay is the measured API time per check from one location, under this run's concurrency, plus a timing model of streamed speech; it is not measured on a phone line.
- Planted errors show what each checker can catch, not how often agents make that error.
- Reference labels come from two models; disagreements are excluded, which removes the hardest cases from the denominators.

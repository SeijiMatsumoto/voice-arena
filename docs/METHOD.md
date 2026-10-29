# Method details

Supplementary to the [README](../README.md) and the [full report](../snapshots/2026-10-29T18-11-07-063Z/README.md):
how the gate works, what each checker is, rules enforced in code, how the study was run and tuned,
and its caveats.

## Gate mechanics

```
LLM token stream ─▶ sentence splitter ─▶ check(sentence, sources) ─▶ voice
                         │                    (runs as soon as each
                         │                     sentence is complete,
                         └─ next sentence ─▶   in parallel)
```

- Sentences are checked as soon as each one is complete, in parallel with generation and with each
  other, and still spoken in order. The first sentence's check sits on the critical path; later checks
  usually finish while earlier sentences are being spoken (the report measures any mid-turn stall).
- **Hold** mode speaks a sentence only after it passes. A blocked sentence is replaced with a
  configured fallback line ("I'll have someone follow up"), and the rest of the turn is dropped.
- **Speak then correct** mode adds no delay. Failed sentences are queued (`takeCorrections()`) so the
  next turn can open with a correction; issuing it is up to the caller of the gate.
- A checker that errors blocks the sentence (fail closed).

**Sources** at any moment means the knowledge pack, plus the caller's account facts *only once
identity is confirmed*, plus the actions actually completed on this call. "I've logged that for you"
is supported only if a tool call really logged it.

## Contenders (by config name)

One entry in [`checkers.yaml`](../checkers.yaml) each. Everything goes through OpenRouter with one key.

| Checker | What it does |
|---|---|
| `none` | Baseline: every sentence is spoken unchecked, as in an agent with no output check. |
| `deterministic` | No model. Every price, time, date and counted quantity must appear in the sources. Spoken forms like "fifteen dollars" and "seven AM" are normalized first. Also blocks pack-specific forbidden phrases, account talk before verification, and claimed actions nobody took. |
| `flash-lite`, `gpt-5.4-nano`, `haiku-5.5` | A small LLM answers one yes/no question with a JSON schema, using minimal reasoning. |
| `jev-1.14` | A decision model returns one probability that the sentence is supported. No text is generated. |
| `cascade-*` | `deterministic` first. Sentences it blocks stay blocked, and sentences with nothing checkable (greetings, questions, empathy) are spoken with no model call. The rest go to the semantic checker. |
| `*-v2`, `*-calibrated` | Tuned variants of the above: `-v2` uses the revised checker prompt, `-calibrated` uses a decision-model cutoff fitted on the tuning scenario. See [Tuning](#tuning-without-tuning-to-the-test). |

All LLM checkers run with minimal reasoning, as a latency-critical check would. (Haiku was initially
missing that setting; the reported results include the fix.)

## Rules enforced in code, not the prompt

| Rule | Where |
|---|---|
| Account facts don't exist for the agent until the caller confirms identity, either by a yes or by matching a field such as date of birth. A denial is permanent for the call. | `CallSession` |
| The agent's prompt omits the call's purpose and call-specific rules until identity is confirmed, so it can't hint at the account (e.g. "she can update her card") to the wrong person. | `agentPrompt` (lab) |
| Tools are validated server-side: no account tools before verification, each request kind at most once per call, unknown kinds rejected. | `CallSession.handleTool` |
| After the call, an audit checks for promised callbacks nobody logged, card numbers read aloud (redacted before storage), dollar amounts not in the sources, and account details spoken before verification. | `auditCall` |

## Study design

[`study.yaml`](../study.yaml) freezes the models, sample sizes and decision limits before any results are seen.

1. **Scenarios.** Each pack has a knowledge file, the caller's account facts, an identity check,
   allowed requests, forbidden phrases and two sets of caller questions: ones the knowledge answers,
   and **bait** questions it deliberately doesn't. The public packs are synthetic and written for this
   benchmark:
   [Brightside Dental](../packs/brightside-dental) (appointment reminder, date-of-birth check) and
   [Northwind Fiber](../packs/northwind-fiber) (past-due bill, yes/no check).
2. **Simulated calls.** The agent (`gpt-5.4-mini`, with tools) talks to LLM callers playing seven
   personas: cooperative, curious, wrong person, wants to cancel, reads out a card number, haggler,
   upset. This is text mode; every agent sentence is recorded with the sources that held at that moment.
3. **Reference labels.** Two models from different families, neither a contender, label each
   sentence independently. Agreement becomes the reference, and disagreement is marked *uncertain*
   and left out of every rate. A `review.jsonl` file of reviewed labels overrides them, each naming
   its reviewer (human, or AI-assisted). **These are model labels, not human ground truth**, and each
   report says how many labels were overridden and by whom.
4. **Planted errors.** Natural errors are rare, so known-bad sentences are added:
   - **Changed numbers** are made mechanically, and the new value is checked to be absent from the sources.
   - **Changed meanings** are written by a model. Both labelers re-check them, and any rewrite they
     both find supported is excluded.

   Planted errors are reported separately and never presented as how often agents make mistakes.
5. **Measures.** All are reported per checker, per scenario and pooled:
   - catch rate on natural errors and on each kind of planted error
   - false-block rate on correct sentences, with 95% Wilson intervals
   - delay before the first word (p50/p95)
   - mid-turn stalls, from a timing model of streamed speech
   - cost per call
6. **Picks, by fixed rules** (`recommend.ts`, no LLM involved), on held-out scenarios only:
   1. A checker is eligible if it blocks at most 5% of correct sentences and adds at most 300 ms p95 before the first word.
   2. The leader is the eligible checker that catches the most.
   3. Checkers not significantly different from the leader (exact McNemar test on paired catches, p ≥ 0.05) are tied with it.
   4. The cheapest of the tied checkers is the pick (then the fastest).

   The same report always gives the same answer.

## Tuning, without tuning to the test

Untuned prompts understate what a checker can do; prompts tuned on the same calls they're scored on
overstate it. The rules (fixed in [`study.yaml`](../study.yaml) and the code, before any tuned results):

- **Tuning scenario vs. held out.** Prompts are revised and cutoffs fitted on `tune_packs`
  (Brightside Dental) only. Picks and the headline come from the other scenarios. Tuning-scenario
  numbers are shown in their own section, labeled as flattering.
- **One revision per version, for every model checker at once.** `prompt: v2` is a single wording
  shared by all LLM and decision-model checkers, written to fix failure *types* seen on the tuning
  scenario, never individual sentences. v1 stays in the table, so the gain (or the lack of one) is
  visible.
- **Decision-model cutoffs by rule.** `threshold: calibrated` picks the highest cutoff whose false-block
  rate on the tuning scenario's correct sentences stays within the 5% limit
  ([`calibrate.ts`](../packages/lab/src/calibrate.ts)), then freezes it in `calibration.json`. Yes/no LLM
  checkers have no such knob.
- **Labels never move with tuning.** Labelers keep the original support rules whatever the checkers
  use, so tuning can't redefine what counts as correct. One tuning-scenario label was corrected by an
  AI-assisted review (an appointment reminder fully backed by the caller's facts, labeled supported
  elsewhere); it is recorded with its reviewer in `review.jsonl`. Held-out labels are untouched.
- **Rules-checker fixes must be generic.** Two were found on the tuning scenario: a date's day read as a
  count ("September 18 visit"), and refusals ("please don't read your card number") tripping forbidden
  phrases. A Northwind-specific rule written earlier, after seeing Northwind data, was removed for the
  same reason.

## Caveats

- Callers are LLMs playing personas. Real callers add speech-recognition errors, interruptions and
  silence, which this text-mode replay doesn't model.
- Latency is API time per check, measured from one location under this run's concurrency, combined
  with a timing model of streamed speech. It is not measured on a phone line.
- Reference labels are model-made. Excluding disagreements removes the hardest cases, which flatters every checker.
- Planted errors show what a checker *can* catch, not how often agents make that mistake. The agent
  rarely erred on its own (4 natural errors in the held-out scenario), so catch rates mostly reflect
  planted errors.
- One held-out scenario. A first, exploratory run on a larger private scenario (a gym retention call
  with a long rulebook) found the same speed picture but more over-blocking: rules → Jev wrongly held
  about 6% of correct sentences, above the 5% limit, with noisy labels. Treat the pick as holding for
  simple knowledge packs.
- Fitted cutoffs and the revised prompt gained less on held-out data than on the tuning scenario;
  the fitted Jev cutoff blocked more correct sentences on held-out data than the default.
- The deterministic checker's claim extraction is English-only and pattern-based. It knows prices,
  percentages, clock times, dates and counted quantities, nothing else.

## Not yet built

Within the speech-gate study:

- **Live audio.** Wire `SpeechGate` into a LiveKit Agents (Node) worker between the LLM and the
  voice, and measure delay on real calls.
- **Hand review** of a sample of labels, especially natural errors and uncertain cases.
- **A local hallucination model** (e.g. HHEM via ONNX in Node) as a contender with no API cost.

Candidate next studies, each reusing the packs, simulated callers and scoring:

- **The agent's own model:** which LLM follows the pack's policy best (cancellation steps, one
  offer, handoffs) at a latency a call can afford.
- **Speech-to-text on names, amounts and dates:** the words a voice agent most needs to hear correctly.
- **End-of-turn detection:** cutting callers off vs. leaving dead air.

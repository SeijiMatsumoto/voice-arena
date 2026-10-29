# Voice Arena

Measured answers to the engineering questions behind production voice agents: quality, latency and
cost together, on realistic simulated calls rather than demos.

| Study | Question | Answer |
|---|---|---|
| **[Speech gate](#study-1-speech-gate)** (2026-10-29) | Can an agent check each sentence against its sources before the caller hears it, and what does that cost in delay? | Yes: free rules plus a fast decision model (Jev), only on sentences with something to check, stopped 90% of wrong sentences and wrongly held 2.6% of correct ones, adding 161 ms. LLM judges added 0.7–1.6 s. |

The pieces shared across studies are scenario packs, simulated callers, the call session (identity
check, tool validation), after-call audits, cached and budgeted model access, and fixed-rule picks.
A new study reuses all of them.

## Study 1: speech gate

<!-- snapshot:start -->
On 42 unsupported sentences (4 natural, 38 planted) across 1 held-out scenario, cascade-jev caught 90% while blocking 2.6% of correct sentences, adding 161 ms p95 before the first word at $0.22 per 1,000 calls. Ignoring the limits, cascade-jev-calibrated caught the most (93%), not a significant difference.

[Latest snapshot](snapshots/2026-10-29T18-11-07-063Z/README.md)
<!-- snapshot:end -->

A phone agent's words are heard as soon as they're generated. Unless something checks the text
between the model and the voice, a wrong fee or an invented policy reaches the caller, and the only
defense is the prompt. Managed platforms can host such a check (e.g. by routing the model through
your own endpoint); this study runs it inside its own orchestration, where every step is visible
and controllable, and measures it: which checkers catch unsupported sentences, how many correct
sentences they wrongly stop, how much silence they add, and what they cost.

The gate is a standalone TypeScript package, [`speech-gate`](packages/speech-gate), with no
dependency on any voice framework. The arena is the harness that evaluates it.

## How the gate works

```
LLM token stream ─▶ sentence splitter ─▶ check(sentence, sources) ─▶ voice
                         │                    (runs as soon as each
                         │                     sentence is complete,
                         └─ next sentence ─▶   in parallel)
```

- Sentences are checked as soon as each one is complete, in parallel with generation and with each
  other, and still spoken in order. Only the first sentence's check sits on the critical path; later
  checks hide behind the speech before them.
- **Hold** mode speaks a sentence only after it passes. A blocked sentence is replaced with the
  pack's fallback line ("I'll have someone follow up"), and the rest of the turn is dropped.
- **Speak then correct** mode adds no delay. Failures are queued, and the next turn opens with a correction.
- A checker that errors blocks the sentence (fail closed).

**Sources** at any moment means the knowledge pack, plus the caller's account facts *only once
identity is confirmed*, plus the actions actually completed on this call. "I've logged that for you"
is supported only if a tool call really logged it.

## Rules enforced in code, not the prompt

| Rule | Where |
|---|---|
| Account facts don't exist for the agent until the caller confirms identity, either by a yes or by matching a field such as date of birth. A denial is permanent for the call. | `CallSession` |
| Tools are validated server-side: no account tools before verification, each request kind at most once per call, unknown kinds rejected. | `CallSession.handleTool` |
| After the call, an audit checks for promised callbacks nobody logged, card numbers read aloud (redacted before storage), dollar amounts not in the sources, and account details spoken before verification. | `auditCall` |

## Contenders

One entry in [`checkers.yaml`](checkers.yaml) each. Everything goes through OpenRouter with one key.

| Checker | What it does |
|---|---|
| `none` | Baseline: every sentence is spoken unchecked, as in an agent with no output check. |
| `deterministic` | No model. Every price, time, date and counted quantity must appear in the sources. Spoken forms like "fifteen dollars" and "seven AM" are normalized first. Also blocks pack-specific forbidden phrases, account talk before verification, and claimed actions nobody took. |
| `flash-lite`, `gpt-5.4-nano`, `haiku-5.5` | A small LLM answers one yes/no question with a JSON schema, using minimal reasoning. |
| `jev-1.14` | A decision model returns one probability that the sentence is supported. No text is generated. |
| `cascade-*` | `deterministic` first. Sentences it blocks stay blocked, and sentences with nothing checkable (greetings, questions, empathy) are spoken with no model call. The rest go to the semantic checker. |

## Study design

[`study.yaml`](study.yaml) freezes the models, sample sizes and decision limits before any results are seen.

1. **Scenarios.** Each pack has a knowledge file, the caller's account facts, an identity check,
   allowed requests, forbidden phrases and two sets of caller questions: ones the knowledge answers,
   and **bait** questions it deliberately doesn't. The public packs are synthetic and written for this
   benchmark:
   [Brightside Dental](packs/brightside-dental) (appointment reminder, date-of-birth check) and
   [Northwind Fiber](packs/northwind-fiber) (past-due bill, yes/no check).
2. **Simulated calls.** The agent (`gpt-5.4-mini`, with tools) talks to LLM callers playing seven
   personas: cooperative, curious, wrong person, wants to cancel, reads out a card number, haggler,
   upset. This is text mode; every agent sentence is recorded with the sources that held at that moment.
3. **Reference labels.** Two models from different families, neither a contender, label each
   sentence independently. Agreement becomes the reference, and disagreement is marked *uncertain*
   and left out of every rate. A `review.jsonl` file of hand labels overrides them. **These are model
   labels, not human ground truth**, and each report says how many were reviewed by hand.
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
6. **Picks, by fixed rules** (`recommend.ts`, no LLM involved):
   1. A checker is eligible if it blocks at most 5% of correct sentences and adds at most 300 ms p95 before the first word.
   2. The leader is the eligible checker that catches the most.
   3. Checkers not significantly different from the leader (exact McNemar test on paired catches, p ≥ 0.05) are tied with it.
   4. The cheapest of the tied checkers is the pick.

   The same report always gives the same answer.

## Tuning, without tuning to the test

Untuned prompts understate what a checker can do; prompts tuned on the same calls they're scored on
overstate it. The rules (fixed in [`study.yaml`](study.yaml) and the code, before any tuned results):

- **Tuning scenario vs. held out.** Prompts are revised and cutoffs fitted on `tune_packs`
  (Brightside Dental) only. Picks and the headline come from the other scenarios. Tuning-scenario
  numbers are shown in their own section, labeled as flattering.
- **One revision per version, for every model checker at once.** `prompt: v2` is a single wording
  shared by all LLM and decision-model checkers, written to fix failure *types* seen on the tuning
  scenario, never individual sentences. v1 stays in the table, so the gain (or the lack of one) is
  visible.
- **Decision-model cutoffs by rule.** `threshold: calibrated` picks the highest cutoff whose false-block
  rate on the tuning scenario's correct sentences stays within the 5% limit
  ([`calibrate.ts`](packages/arena/src/calibrate.ts)), then freezes it in `calibration.json`. Yes/no LLM
  checkers have no such knob.
- **Labels never move.** Labelers keep the original support rules whatever the checkers use, so tuning
  can't redefine what counts as correct.
- **Rules-checker fixes must be generic.** Two were found on the tuning scenario: a date's day read as a
  count ("September 18 visit"), and refusals ("please don't read your card number") tripping forbidden
  phrases. A Northwind-specific rule written earlier, after seeing Northwind data, was removed for the
  same reason.

## Running it

Node 22+.

```bash
npm install
cp .env.example .env                 # OPENROUTER_API_KEY=...
npm test                             # unit tests, offline
npm run arena -- all --mock          # whole pipeline offline with stand-in models, no key needed

npm run arena -- list                # packs, personas, checkers
npm run arena -- simulate            # agent vs. simulated callers
npm run arena -- plant               # planted errors
npm run arena -- label               # reference labels (needs the plants)
npm run arena -- run                 # all checkers -> reports/live/<time>/report.md
npm run arena -- show
npm run arena -- snapshot            # copy into snapshots/ and update the block above
```

Every API response is cached on disk, keyed by the exact request, so reruns only pay for what's new.
Each command stops at `budget_usd` of uncached spend. A full run over both public packs costs
about $1–2.

## Web interface

```bash
cd web && npm ci && npm run build && cd ..
npm run arena -- serve               # http://127.0.0.1:8004
```

- **Results:** the finding, errors caught against delay and against cost (with the latency budget
  marked), every checker's numbers, and the fixed-rule picks.
- **Calls:** each simulated transcript, with every agent sentence marked by its reference label and
  the selected checker's verdict, and a per-turn timeline of checks, added silence and speech.
- **Sentences:** every natural and planted sentence against every checker. Filters show misses,
  false blocks and disagreements; a side panel shows labeler votes and what was planted.
- **Playground:** check one sentence, or stream a whole agent reply through the gate word by word,
  in hold or speak-then-correct mode.

Browsing never calls a model. Paid checks in the playground need an explicit toggle and
`OPENROUTER_API_KEY` in `.env`. Frontend development: `npm run dev` in `web/` (port 5177, proxies `/api`).

## Using the gate in your own pipeline

```ts
import { CallSession, CascadeChecker, DeterministicChecker, DecisionChecker,
         SpeechGate, createOpenRouterClient, fetchTransport } from "@voice-arena/speech-gate";

const client = createOpenRouterClient(fetchTransport(process.env.OPENROUTER_API_KEY!));
const rules = new DeterministicChecker({ forbidden: [], claimTerms: ["fee", "refund"] });
const gate = new SpeechGate({
  checker: new CascadeChecker("cascade-jev", rules, new DecisionChecker("jev", client, "typesafe/jev-1.14")),
  mode: "hold",
  fallback: "I want to get that right, so I'll have someone follow up.",
});

const session = new CallSession({ knowledge, identity, callerFacts, requestKinds: ["reschedule"] });
for await (const event of gate.run(llmTokenStream, { sources: session.sources() })) {
  if (event.type === "speak") tts.say(event.text);   // a blocked sentence never reaches here
}
```

## Adding a scenario or a checker

- **Scenario:** add `packs/<id>/pack.yaml` and `knowledge.md` (copy an existing pack). Nothing else changes.
- **Private scenario:** put it in `packs-private/<id>/`, which is gitignored. Its data, reports and
  snapshots stay inside that folder, and private packs only run when named (`--packs <id>`).
- **Checker:** add an entry to `checkers.yaml`. A new *kind* is a class implementing `Checker`
  (`check(input) → Verdict`).

## Layout

| Path | What it is |
|---|---|
| `packages/speech-gate/` | The library: sentence splitter, claim extraction, checkers, streaming gate, call session, audit |
| `packages/arena/` | CLI, call simulator, planted errors, labels, runner, metrics, fixed-rule picks, report |
| `packs/` | Public synthetic scenarios and their generated data |
| `study.yaml`, `checkers.yaml` | Frozen study settings and the contenders |
| `snapshots/` | Dated results; the block at the top points to the latest |

## Caveats

- Callers are LLMs playing personas. Real callers add speech-recognition errors, interruptions and
  silence, which this text-mode replay doesn't model.
- Latency is API time per check, measured from one location under this run's concurrency, combined
  with a timing model of streamed speech. It is not measured on a phone line.
- Reference labels are model-made. Excluding disagreements removes the hardest cases, which flatters every checker.
- Planted errors show what a checker *can* catch, not how often agents make that mistake.
- The deterministic checker's claim extraction is English-only and pattern-based. It knows prices,
  percentages, clock times, dates and counted quantities, nothing else.

## Not yet

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

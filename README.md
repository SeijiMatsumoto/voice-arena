# Voice Arena

Experiments on making AI phone agents accurate and fast enough for real customers, each measured
on simulated calls with its method and limits written down.

| Study | Question | Short answer |
|---|---|---|
| [1. Checking before speaking](#study-1-checking-before-speaking) | Can an agent's sentences be checked before the caller hears them, without slowing the call? | Fast and cheap enough, yes. Worth it on real mistakes, not yet shown. |

## Study 1: Checking before speaking

AI agents occasionally say things their sources don't support, like a wrong fee or an invented
policy. Checking each sentence before it's spoken would stop that, but every check adds silence, and
a strict check replaces correct answers with "someone will follow up". Limits set in advance: at most
5% of correct sentences stopped, at most 300 ms of added silence.

**Method.** 42 simulated calls for two made-up businesses, with AI "customers" from cooperative to
upset. Every agent sentence, plus planted mistakes, went through each check: plain rules, AI models,
a fast decision model (Jev), and combinations. Tuned on one business, measured on the other.

### What it found

<!-- snapshot:start -->
- **Fast and cheap enough.** Rules → Jev stopped 90% of wrong sentences, wrongly stopped 2.6% of correct ones, and added 161 ms of silence, at $0.22 per 1,000 calls.
- **General AI models are too slow.** Checking every sentence with one added 0.7–1.4 s of silence.
- **Value on real mistakes is unproven.** The agent was already right 97% of the time. Of its 4 real mistakes, the check stopped 1, and it wrongly held 4 correct sentences; most of the 90% comes from planted mistakes. Best aimed at costly claims (fees, refunds, promises).

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

**[Full report](snapshots/2026-10-29T18-11-07-063Z/README.md)**: method, all findings, limitations, next steps.
<!-- snapshot:end -->

### How the check works

```
agent's words ─▶ sentences ─▶ check each against the company's info ─▶ speak, or say "someone will follow up"
```

Each sentence is checked as soon as it's complete, while the agent keeps talking, so usually only a
reply's first sentence waits. The check is a standalone library
([`packages/speech-gate`](packages/speech-gate)); the rest of the repo is the lab that measures it.
Managed voice platforms can host a check like this too (e.g. via a custom model endpoint); here it
runs in its own small pipeline so every step is visible and timed.

---

# For developers

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
Each command stops at `budget_usd` of uncached spend. The full study over both public packs, all 18
checkers included, cost under $1.

## Web interface

```bash
cd web && npm ci && npm run build && cd ..
npm run arena -- serve               # http://127.0.0.1:8004
```

- **Results:** the question and answer in plain English, a "how to read this page" glossary, errors
  caught against delay and against cost (with the latency budget marked), one comparison table with
  a verdict per approach (tuned variants and detail columns behind toggles), "Did tuning help?"
  (tuning scenario vs. held out), what callers would hear, and the statistics behind the pick.
- **Calls:** each simulated transcript, with every agent sentence marked by its reference label and
  the selected checker's verdict, and a per-turn timeline of checks, added silence and speech.
- **Sentences:** every natural and planted sentence against every checker. Filters show misses,
  false blocks and disagreements; a side panel shows labeler votes and what was planted.
- **Playground:** check one sentence, or stream a whole agent reply through the gate word by word,
  in hold or speak-then-correct mode.

Browsing never calls a model. Paid checks in the playground need an explicit toggle and
`OPENROUTER_API_KEY` in `.env`. Frontend development: `npm run dev` in `web/` (port 5177, proxies `/api`).

## Using the gate in your own pipeline

`speech-gate` is a workspace package in this repo, not published to npm; copy or link
`packages/speech-gate`.

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
- **Private scenario:** put it in `packs-private/<id>/`, which is gitignored. Its generated data stays
  in that folder, snapshots of reports that include it go to `packs-private/snapshots/`, and private
  packs only run when named (`--packs <id>`). (`reports/` is gitignored too.)
- **Playground examples:** an optional `playground: { sentence, turn }` in `pack.yaml`.
- **Checker:** add an entry to `checkers.yaml`. A new *kind* is a class implementing `Checker`
  (`check(input) → Verdict`).

## Layout

Two packages, so the guardrail can be reused without the experiment around it:

- **`packages/speech-gate/`: the guardrail itself.** A small library you'd put inside a voice agent:
  splits the agent's text into sentences, checks each one, decides speak or block. It also has the
  identity check and the after-call audit. Nothing in it is about experiments.
- **`packages/lab/`: the test lab around it.** Simulates calls, plants errors, gets labels, runs
  every checker, scores them, writes reports and serves the web UI. It is the `npm run arena`
  command.

| Path | What it is |
|---|---|
| `packages/speech-gate/` | The guardrail library: sentence splitter, claim extraction, checkers, streaming gate, call session, audit |
| `packages/lab/` | The test lab: CLI, call simulator, planted errors, labels, runner, metrics, fixed-rule picks, reports, web server |
| `packs/` | Public synthetic scenarios and their generated data |
| `web/` | The local web UI (React + Vite) served by `arena serve` |
| `study.yaml`, `checkers.yaml` | Frozen study settings and the contenders |
| `calibration.json` | Decision-model cutoffs fitted on the tuning scenario, frozen for every other run |
| `snapshots/` | Dated results; the block at the top points to the latest |

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

One entry in [`checkers.yaml`](checkers.yaml) each. Everything goes through OpenRouter with one key.

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

## Method details

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
  ([`calibrate.ts`](packages/lab/src/calibrate.ts)), then freezes it in `calibration.json`. Yes/no LLM
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

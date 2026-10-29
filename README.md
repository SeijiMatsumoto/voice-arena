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
| `docs/METHOD.md` | Method details: checkers, study design, tuning, caveats |
| `snapshots/` | Dated results; the block at the top points to the latest |

## More detail

[`docs/METHOD.md`](docs/METHOD.md): how the gate works, each checker, rules enforced in code, the
study design, how tuning was kept separate from scoring, caveats and what's not built yet.

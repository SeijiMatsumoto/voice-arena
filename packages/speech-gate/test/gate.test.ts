import { describe, expect, it } from "vitest";
import {
  auditCall,
  CallSession,
  CascadeChecker,
  DeterministicChecker,
  extractClaims,
  redactCardNumbers,
  SpeechGate,
  splitSentences,
  type Checker,
  type Sources,
  type Verdict,
} from "../src/index.js";

const knowledge = `Hours: Monday to Friday 7 a.m. to 9 p.m.
A missed payment adds a $15 late fee.
Members may freeze for up to 3 months once per year.
Cancellation needs 30 days notice.`;
const sources: Sources = { knowledge, callerFacts: { first_name: "Priya", last_payment: "declined on June 3" }, actions: [] };
const rules = new DeterministicChecker({ forbidden: [{ pattern: "card number", reason: "asks for card details" }], claimTerms: ["freeze"] });

describe("claims", () => {
  it("normalizes spoken and written forms to the same key", () => {
    const keys = (s: string) => extractClaims(s).map((c) => c.key);
    expect(keys("a $15 fee")).toEqual(keys("a fifteen dollar fee"));
    expect(keys("open at 7 a.m.")).toEqual(keys("open at seven AM"));
    expect(keys("$24.99 a month")).toEqual(["money:2499"]);
    expect(keys("up to three months")).toEqual(["quantity:3:month"]);
    expect(keys("on June 3rd")).toEqual(["date:6-3"]);
    expect(keys("from your September 18 visit")).toEqual(["date:9-18"]);
  });
});

describe("sentence splitting", () => {
  it("keeps decimals, times and abbreviations inside a sentence", () => {
    expect(splitSentences("It's $24.99 a month. We open at 7 a.m. on weekdays. Dr. Lee is in. Okay?")).toEqual([
      "It's $24.99 a month.",
      "We open at 7 a.m. on weekdays.",
      "Dr. Lee is in.",
      "Okay?",
    ]);
  });
  it("ends a sentence on a time suffix followed by a capital", () => {
    expect(splitSentences("We open at 7 a.m. See you then.")).toEqual(["We open at 7 a.m.", "See you then."]);
  });
});

describe("deterministic checker", () => {
  const check = (sentence: string, s = sources) => rules.check({ sentence, sources: s });
  it("passes claims found in the sources", async () => {
    expect((await check("There's a fifteen dollar late fee.")).pass).toBe(true);
    expect((await check("You can freeze for up to 3 months.")).pass).toBe(true);
  });
  it("blocks numbers the sources don't contain", async () => {
    expect((await check("The late fee is $25.")).pass).toBe(false);
    expect((await check("We open at 6 a.m.")).pass).toBe(false);
  });
  it("blocks forbidden requests and actions nobody took", async () => {
    expect((await check("Could you read me your card number?")).pass).toBe(false);
    expect((await check("I've waived the late fee for you.")).pass).toBe(false);
    expect((await check("I've logged that for you.", { ...sources, actions: ["Callback requested"] })).pass).toBe(true);
  });
  it("doesn't treat refusing a forbidden thing as doing it", async () => {
    expect((await check("Please don\u2019t read your card number to me.")).pass).toBe(true);
    expect((await check("I can't take a card number on this call.")).pass).toBe(true);
  });
  it("reads curly apostrophes like straight ones", async () => {
    expect((await check("I\u2019ve waived the late fee for you.")).pass).toBe(false);
  });
  it("blocks account talk before identity is confirmed", async () => {
    expect((await check("I'm calling about your payment.", { ...sources, callerFacts: undefined })).pass).toBe(false);
  });
});

class FakeChecker implements Checker {
  readonly name = "fake";
  calls: string[] = [];
  constructor(private readonly bad: string[], private readonly delayMs = 5) {}
  async check({ sentence }: { sentence: string }): Promise<Verdict> {
    this.calls.push(sentence);
    await new Promise((r) => setTimeout(r, this.delayMs));
    const pass = !this.bad.some((b) => sentence.includes(b));
    return { pass, reasons: pass ? [] : ["bad"], latencyMs: this.delayMs, costUsd: 0 };
  }
}

async function* stream(text: string) {
  for (const word of text.split(/(?<= )/)) yield word;
}

async function collect(gate: SpeechGate, text: string) {
  const out = [];
  for await (const e of gate.run(stream(text), { sources })) out.push(e);
  return out;
}

describe("speech gate", () => {
  const text = "Thanks for confirming. Your fee is $99. Anything else?";
  it("hold: replaces the first failing sentence with the fallback and drops the rest", async () => {
    const gate = new SpeechGate({ checker: new FakeChecker(["$99"]), mode: "hold", fallback: "Let me check that." });
    const events = await collect(gate, text);
    expect(events.map((e) => `${e.type}:${e.text}`)).toEqual([
      "speak:Thanks for confirming.",
      "blocked:Your fee is $99.",
      "speak:Let me check that.",
    ]);
  });
  it("speak-then-correct: speaks everything and queues the failure for the next turn", async () => {
    const gate = new SpeechGate({ checker: new FakeChecker(["$99"]), mode: "speak-then-correct", fallback: "" });
    const events = await collect(gate, text);
    expect(events.every((e) => e.type === "speak")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(gate.takeCorrections()).toEqual(["Your fee is $99."]);
  });
  it("checks sentences concurrently, not one after another", async () => {
    const checker = new FakeChecker([], 50);
    const gate = new SpeechGate({ checker, mode: "hold", fallback: "" });
    const started = performance.now();
    await collect(gate, "One. Two. Three. Four.");
    expect(performance.now() - started).toBeLessThan(150);
    expect(checker.calls).toHaveLength(4);
  });
});

describe("cascade", () => {
  it("skips the model for sentences with nothing to check", async () => {
    const model = new FakeChecker([]);
    const cascade = new CascadeChecker("cascade", rules, model);
    await cascade.check({ sentence: "How has your week been?", sources });
    await cascade.check({ sentence: "The late fee is $25.", sources });
    await cascade.check({ sentence: "You could freeze instead.", sources });
    expect(model.calls).toEqual(["You could freeze instead."]);
  });
});

describe("call session", () => {
  const spec = {
    knowledge,
    identity: { prompt: "Am I speaking with Priya?", check: { type: "affirm" as const } },
    callerFacts: sources.callerFacts!,
    requestKinds: ["accept_offer"],
  };
  it("releases account facts only after the caller confirms", () => {
    const session = new CallSession(spec);
    expect(session.sources().callerFacts).toBeUndefined();
    expect(session.handleTool("log_callback", { reason: "x" }).ok).toBe(false);
    session.observeCaller("Yes, speaking.");
    expect(session.sources().callerFacts?.first_name).toBe("Priya");
  });
  it("treats a denial as the wrong party, permanently", () => {
    const session = new CallSession(spec);
    session.observeCaller("No, this is her roommate.");
    session.observeCaller("Yes.");
    expect(session.stage).toBe("wrong-party");
    expect(session.tools().map((t) => t.function.name)).toEqual(["end_call"]);
  });
  it("allows each request kind once", () => {
    const session = new CallSession(spec);
    session.observeCaller("yeah");
    expect(session.handleTool("record_request", { kind: "accept_offer", detail: "fee waiver" }).ok).toBe(true);
    expect(session.handleTool("record_request", { kind: "accept_offer", detail: "again" }).ok).toBe(false);
    expect(session.handleTool("record_request", { kind: "refund", detail: "" }).ok).toBe(false);
  });
});

describe("audit", () => {
  it("flags unlogged callbacks, card numbers and invented amounts", () => {
    const findings = auditCall({
      transcript: [
        { speaker: "agent", text: "Am I speaking with Priya?", stage: "verify" },
        { speaker: "caller", text: "Yes. My card is 4111 1111 1111 1111.", stage: "verify" },
        { speaker: "agent", text: "Someone will call you back. The fee is $40.", stage: "active" },
      ],
      actions: [],
      knowledge,
      callerFacts: sources.callerFacts!,
      publicFields: ["first_name"],
    });
    expect(findings.map((f) => f.rule).sort()).toEqual(["amount-not-in-sources", "callback-promised-not-logged", "card-number-in-transcript"]);
    expect(redactCardNumbers("card 4111 1111 1111 1111 ok")).toBe("card [card number removed] ok");
  });
});

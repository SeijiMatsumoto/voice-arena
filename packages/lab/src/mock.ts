import { claimKeys, extractClaims, type TransportResult } from "@voice-arena/speech-gate";
import { hashUnit, type Role } from "./gateway.js";

/**
 * Offline stand-ins with the same request and response shapes as OpenRouter, so every command runs
 * without a key. Answers are deterministic functions of the request. Mock numbers say nothing about
 * real models; reports built from them are labeled MOCK.
 */

const MOCK_PLANT = "That also includes free parking on weekends.";

export function mockResponse(role: Role, url: string, body: any): TransportResult {
  const seed = JSON.stringify(body);
  const h = hashUnit(seed);
  const usage = { prompt_tokens: Math.round(seed.length / 4), completion_tokens: 30 };
  if (url.endsWith("/decisions")) {
    const supported = noisy(oracle(String(body.state.sentence), String(body.state.sources)), body.model, seed);
    return { payload: { answers: { q: { noul: supported ? 0.8 + 0.2 * h : 0.2 * h } }, usage }, latencyMs: 80 + 140 * h, cached: false };
  }
  const messages: { role: string; content?: string }[] = body.messages;
  const system = messages[0]?.content ?? "";
  const user = messages.at(-1)?.content ?? "";
  const reply = (content: string, tool_calls?: unknown[], latency = 300 + 400 * h): TransportResult => ({
    payload: { choices: [{ message: { content, tool_calls } }], usage },
    latencyMs: latency,
    cached: false,
  });

  switch (role) {
    case "agent":
      return agentTurn(messages, system, seed, reply);
    case "caller":
      return reply(callerTurn(messages, system), undefined, 0);
    case "mutator": {
      const sentence = section(user, "Sentence");
      return reply(JSON.stringify({ sentence: `${sentence} ${MOCK_PLANT}`, change: "added an unsupported perk" }));
    }
    case "labeler":
    case "checker": {
      const sentence = section(user, "Sentence the agent is about to say");
      const supported = noisy(oracle(sentence, user), body.model, seed, role === "labeler" ? 0.95 : undefined);
      return reply(JSON.stringify({ unsupported_claims: supported ? [] : [sentence], supported }));
    }
  }
}

/** Ground truth for mock runs: every claim must appear in the sources, and no planted perk. */
function oracle(sentence: string, sourcesText: string): boolean {
  if (sentence.includes(MOCK_PLANT)) return false;
  const known = claimKeys(sourcesText.split("## Sentence the agent is about to say")[0]!);
  return extractClaims(sentence).every((c) => known.has(c.key));
}

function noisy(truth: boolean, model: string, seed: string, accuracy?: number): boolean {
  const acc = accuracy ?? 0.78 + 0.18 * hashUnit(model);
  return hashUnit(`${model}|${seed}|noise`) < acc ? truth : !truth;
}

/** Text under "## heading", up to `until` (another heading) or the next "## " heading. */
function section(text: string, heading: string, until?: string): string {
  const start = text.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const rest = text.slice(start + heading.length + 4);
  const end = rest.indexOf(until ? `\n## ${until}\n` : "\n## ");
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function agentTurn(messages: any[], system: string, seed: string, reply: (c: string, t?: unknown[]) => TransportResult) {
  const endCall = [{ id: `call_${hashUnit(seed).toString(36).slice(2, 8)}`, type: "function", function: { name: "end_call", arguments: "{}" } }];
  if (messages.at(-1)?.role === "tool") return reply("");
  const stage = /Call stage: (\S+)/.exec(system)?.[1];
  if (stage === "wrong-party") return reply("Sorry for the mix-up. Have a good day.", endCall);
  if (stage === "verify") return reply("Sorry, I didn't quite catch that. Could you confirm that for me?");
  const callerTurns = messages.filter((m) => m.role === "user").length;
  if (callerTurns >= 4) return reply("Thanks for your time today. Goodbye.", endCall);

  const facts = section(system, "Caller facts").split("\n").filter((l) => l.startsWith("- "));
  const knowledge = section(system, "Knowledge", "Caller facts").split("\n").filter((l) => /\d/.test(l) && l.length < 160);
  const pick = <T,>(xs: T[], salt: string) => xs[Math.floor(hashUnit(seed + salt) * xs.length)];
  const parts: string[] = [];
  if (callerTurns === 1) {
    const fact = pick(facts, "fact")?.slice(2).split(": ");
    parts.push("Thanks for confirming.");
    if (fact) parts.push(`I see your ${fact[0]!.replace(/_/g, " ")} is ${fact[1]}.`);
  }
  let line = (pick(knowledge, "kb") ?? "We're happy to help.").replace(/^[-*#\s]+/, "").replace(/\*\*/g, "");
  // A natural-looking error in about one sentence in five.
  if (hashUnit(seed + "err") < 0.2) {
    const bump = (n: string) => String(Number(n) + 3);
    line = /\$\d+/.test(line) ? line.replace(/\$(\d+)/, (_, n) => `$${bump(n)}`) : line.replace(/\d+/, bump);
  }
  parts.push(/[.!?]$/.test(line) ? line : `${line}.`);
  parts.push("Is there anything else I can help with?");
  return reply(parts.join(" "));
}

function callerTurn(messages: any[], system: string): string {
  const own = messages.filter((m) => m.role === "assistant").length;
  if (own === 0) return /Identity answer: "([^"]*)"/.exec(system)?.[1] ?? "Yes, speaking.";
  const questions = section(system, "Questions you want to ask").split("\n").filter((l) => l.startsWith("- "));
  const q = questions[own - 1];
  return q ? q.replace(/^- /, "") : "Okay, thanks. Bye.";
}

import {
  auditCall,
  CallSession,
  redactCardNumbers,
  splitSentences,
  type Action,
  type AuditFinding,
  type Stage,
  type TranscriptTurn,
} from "@voice-arena/speech-gate";
import type { Pack, Study } from "./config.js";
import { hashUnit, type Gateway } from "./gateway.js";
import type { Persona } from "./personas.js";

/** One spoken agent sentence, with what was true at the moment it was said. */
export interface SentenceRecord {
  id: string;
  pack: string;
  callId: string;
  persona: string;
  /** Agent turn number (1 = first reply after the scripted opening). */
  turn: number;
  /** Position within the turn, from 0. */
  position: number;
  sentence: string;
  stage: Stage;
  /** Caller facts were part of the sources (identity confirmed). */
  facts: boolean;
  actions: string[];
  previousCallerTurn: string;
  origin: "natural" | "planted-numeric" | "planted-semantic";
  /** For planted sentences: the natural sentence it was made from, and what changed. */
  parentId?: string;
  change?: string;
}

export interface CallRecord {
  callId: string;
  pack: string;
  persona: string;
  /** Card numbers redacted. */
  transcript: TranscriptTurn[];
  actions: Action[];
  audit: AuditFinding[];
  endedBy: "agent" | "caller" | "max-turns";
}

export function agentPrompt(pack: Pack, session: CallSession): string {
  const stage = {
    verify: `The caller's identity is NOT confirmed. Say nothing about why you're calling beyond the greeting, and nothing about their account. You already asked: "${pack.identity.prompt}". If the answer was unclear, ask once more.`,
    active: "The caller's identity is confirmed. You may discuss the caller facts below.",
    "wrong-party": "This is not the person you're calling for. Say nothing about the account or the reason for the call, apologize briefly, say goodbye and call end_call.",
  }[session.stage];
  const verified = session.stage === "active";
  const facts = verified
    ? Object.entries(pack.caller_facts).map(([k, v]) => `- ${k}: ${v}`).join("\n")
    : "(not available until identity is confirmed)";
  // The purpose and call-specific rules describe the account ("payment declined"), so they are
  // withheld until identity is confirmed, like the facts; otherwise the agent can hint at them.
  const purpose = verified ? pack.agent.purpose : "(withheld until the caller's identity is confirmed; do not hint at it)";
  const callRules = verified ? pack.agent.rules.map((r) => `- ${r}`).join("\n") : "";
  return `You are ${pack.agent.role} You are on a live phone call; everything you write is spoken aloud.
Purpose of this call: ${purpose}

How to speak: short, natural spoken sentences, at most three per turn. No lists or markdown. Write prices, times and numbers as digits ($15, 7 a.m.).

Rules:
- Use only the knowledge and caller facts below. If the answer isn't there, say you don't have that information and offer to have someone follow up (log_callback).
- Never say something is done unless a tool confirmed it. Requests you record are reviewed by staff before anything is applied; say so.
- Never take payment details over the phone.
${callRules}

Call stage: ${session.stage}
${stage}

## Knowledge
${pack.knowledge.trim()}

## Caller facts
${facts}`;
}

function identityAnswer(pack: Pack, persona: Persona): string {
  const name = pack.caller_facts.first_name ?? "them";
  const check = pack.identity.check;
  if (persona.identity === "deny") return `No, I'm not ${name}. This is ${pack.other_party}.`;
  if (check.type === "affirm") return `Yes, this is ${name}.`;
  return `Sure, it's ${pack.caller_facts[check.field]}.`;
}

function callerQuestions(pack: Pack, persona: Persona, callId: string): string[] {
  const { from, count } = persona.questions;
  const pool =
    from === "mixed"
      ? [...pack.questions.in_pack.slice(0, 1), ...pack.questions.bait]
      : pack.questions[from];
  return [...pool].sort((a, b) => hashUnit(callId + a) - hashUnit(callId + b)).slice(0, count);
}

function callerPrompt(pack: Pack, persona: Persona, callId: string): string {
  const facts = persona.identity === "confirm"
    ? `What you know about your own account: ${Object.entries(pack.caller_facts).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("; ")}.`
    : "";
  return `You are role-playing someone who just answered a phone call. Speak as a person on the phone: one or two short sentences per reply, no stage directions, no narration.
${persona.brief}
${facts}
When they first ask who you are, answer with this meaning.
Identity answer: "${identityAnswer(pack, persona)}"

## Questions you want to ask
${callerQuestions(pack, persona, callId).map((q) => `- ${q}`).join("\n")}

Ask them naturally, one per reply. When you have nothing left to ask, say goodbye.`;
}

const GOODBYE = /\b(?:bye|goodbye)\b/i;

export async function simulateCall(
  pack: Pack,
  persona: Persona,
  index: number,
  study: Study,
  gw: Gateway,
): Promise<{ call: CallRecord; sentences: SentenceRecord[] }> {
  const callId = `${pack.id}:${persona.id}:${index}`;
  const seed = Math.floor(hashUnit(callId) * 1e9);
  const session = new CallSession({
    knowledge: pack.knowledge,
    identity: pack.identity,
    callerFacts: pack.caller_facts,
    requestKinds: pack.request_kinds,
  });
  const opening = `${pack.agent.greeting} ${pack.identity.prompt}`;
  const transcript: TranscriptTurn[] = [{ speaker: "agent", text: opening, stage: "verify" }];
  const agentHistory: any[] = [{ role: "assistant", content: opening }];
  const sentences: SentenceRecord[] = [];
  const callerSystem = callerPrompt(pack, persona, callId);
  let endedBy: CallRecord["endedBy"] = "max-turns";

  for (let turn = 1; turn <= study.max_agent_turns; turn++) {
    // Caller speaks; the caller model sees the agent as "user".
    const callerBody = {
      model: study.caller.model,
      messages: [
        { role: "system", content: callerSystem },
        ...transcript.map((t) => ({ role: t.speaker === "agent" ? "user" : "assistant", content: t.text })),
      ],
      temperature: study.caller.temperature,
      max_tokens: 120,
      seed,
      usage: { include: true },
    };
    const callerPayload = (await gw.transport("caller")("https://openrouter.ai/api/v1/chat/completions", callerBody)).payload;
    const callerText = String(callerPayload?.choices?.[0]?.message?.content ?? "").trim() || "Sorry, what was that?";
    transcript.push({ speaker: "caller", text: callerText, stage: session.stage });
    session.observeCaller(callerText);
    agentHistory.push({ role: "user", content: callerText });

    // Agent replies, possibly calling tools first.
    const stage = session.stage;
    let text = "";
    let ended = false;
    for (let step = 0; step < 3 && !ended; step++) {
      const body = {
        model: study.agent.model,
        messages: [{ role: "system", content: agentPrompt(pack, session) }, ...agentHistory],
        tools: session.tools(),
        temperature: study.agent.temperature,
        max_tokens: 300,
        seed,
        usage: { include: true },
      };
      const message = (await gw.transport("agent")("https://openrouter.ai/api/v1/chat/completions", body)).payload?.choices?.[0]?.message ?? {};
      const content = String(message.content ?? "").trim();
      if (content) text = text ? `${text} ${content}` : content;
      const calls: any[] = message.tool_calls ?? [];
      if (!calls.length) {
        agentHistory.push({ role: "assistant", content });
        break;
      }
      agentHistory.push({ role: "assistant", content: content || null, tool_calls: calls });
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch {
          // a malformed call is rejected like an invalid one
        }
        const result = session.handleTool(call.function?.name, args);
        if (call.function?.name === "end_call") ended = true;
        agentHistory.push({ role: "tool", tool_call_id: call.id, content: result.message });
      }
    }

    if (text) {
      transcript.push({ speaker: "agent", text, stage });
      splitSentences(text).forEach((sentence, position) => {
        sentences.push({
          id: `${callId}:${turn}:${position}`,
          pack: pack.id,
          callId,
          persona: persona.id,
          turn,
          position,
          sentence,
          stage,
          facts: stage === "active",
          actions: session.actions.map((a) => a.description),
          previousCallerTurn: redactCardNumbers(callerText),
          origin: "natural",
        });
      });
    }
    if (ended) {
      endedBy = "agent";
      break;
    }
    if (GOODBYE.test(callerText)) {
      endedBy = "caller";
      break;
    }
  }

  const audit = auditCall({
    transcript,
    actions: session.actions,
    knowledge: pack.knowledge,
    callerFacts: pack.caller_facts,
    publicFields: pack.identity.public_fields,
  });
  return {
    call: {
      callId,
      pack: pack.id,
      persona: persona.id,
      transcript: transcript.map((t) => ({ ...t, text: redactCardNumbers(t.text) })),
      actions: session.actions,
      audit,
      endedBy,
    },
    sentences,
  };
}

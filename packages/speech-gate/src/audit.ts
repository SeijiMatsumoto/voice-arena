import { claimKeys, extractClaims, straightenQuotes } from "./claims.js";
import type { Action, Stage } from "./session.js";

/** Checks over a finished call: things a sentence-level gate can't see, or that must never slip through. */

export interface TranscriptTurn {
  speaker: "agent" | "caller";
  text: string;
  /** Call stage when the turn was spoken. */
  stage: Stage;
}

export interface AuditFinding {
  rule: "callback-promised-not-logged" | "card-number-in-transcript" | "amount-not-in-sources" | "account-detail-before-verify";
  turn: number;
  detail: string;
}

const PROMISES_CALLBACK = /\b(?:call you back|get back to you|reach out to you|follow up with you|someone (?:will|is going to) (?:call|contact|reach))\b/i;
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function redactCardNumbers(text: string): string {
  return text.replace(CARD_CANDIDATE, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number removed]" : m));
}

export function auditCall(input: {
  transcript: TranscriptTurn[];
  actions: Action[];
  knowledge: string;
  callerFacts: Record<string, string>;
  /** Facts the agent may say before verification, e.g. the first name it asks for. */
  publicFields: string[];
}): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const known = claimKeys(`${input.knowledge}\n${Object.values(input.callerFacts).join("\n")}`);
  const loggedCallback = input.actions.some((a) => a.tool === "log_callback");
  const privateValues = Object.entries(input.callerFacts)
    .filter(([field, value]) => !input.publicFields.includes(field) && value.length >= 4)
    .map(([, value]) => value.toLowerCase());

  input.transcript.forEach((turn, i) => {
    if (turn.speaker === "caller") {
      for (const m of turn.text.matchAll(CARD_CANDIDATE)) {
        if (luhn(m[0].replace(/\D/g, ""))) findings.push({ rule: "card-number-in-transcript", turn: i, detail: "caller read out a card number; redact before storing" });
      }
      return;
    }
    if (PROMISES_CALLBACK.test(straightenQuotes(turn.text)) && !loggedCallback) {
      findings.push({ rule: "callback-promised-not-logged", turn: i, detail: "agent promised a follow-up that nobody was asked to do" });
    }
    for (const claim of extractClaims(turn.text)) {
      if (claim.kind === "money" && !known.has(claim.key)) {
        findings.push({ rule: "amount-not-in-sources", turn: i, detail: claim.text });
      }
    }
    if (turn.stage !== "active") {
      const lower = turn.text.toLowerCase();
      for (const value of privateValues) {
        if (lower.includes(value)) findings.push({ rule: "account-detail-before-verify", turn: i, detail: value });
      }
    }
  });
  return findings;
}

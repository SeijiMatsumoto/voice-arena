import type { Sources } from "./types.js";

/**
 * Call rules enforced in code, not in the prompt: the caller's account facts don't exist for the agent
 * until identity is confirmed, and tools are validated by the server.
 */

export type IdentityCheck = { type: "affirm" } | { type: "match"; field: string };

export interface CallSpec {
  knowledge: string;
  identity: { prompt: string; check: IdentityCheck };
  callerFacts: Record<string, string>;
  /** Kinds of request the agent may record, e.g. "accept_offer", "reschedule". Each at most once per call. */
  requestKinds: string[];
}

export type Stage = "verify" | "active" | "wrong-party";

export interface Action {
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

const NEGATIVE = /\b(?:no|nope|not|wrong (?:number|person)|isn'?t|doesn'?t|don'?t know)\b/i;
const AFFIRM = /\b(?:yes|yeah|yep|yup|speaking|that'?s me|this is (?:she|he|they|me|her|him)|it is|correct|uh-huh|sure is)\b/i;
const MAX_IDENTITY_ATTEMPTS = 2;

export class CallSession {
  stage: Stage = "verify";
  readonly actions: Action[] = [];
  private identityAttempts = 0;

  constructor(readonly spec: CallSpec) {}

  /** Feed each caller utterance; during verification it decides whether the account opens. */
  observeCaller(text: string): Stage {
    if (this.stage !== "verify") return this.stage;
    this.identityAttempts++;
    const { check } = this.spec.identity;
    let verified = false;
    if (check.type === "affirm") {
      if (AFFIRM.test(text) && !NEGATIVE.test(text)) verified = true;
      else if (NEGATIVE.test(text)) this.stage = "wrong-party";
    } else {
      verified = matchesValue(text, this.spec.callerFacts[check.field] ?? "");
    }
    if (verified) this.stage = "active";
    else if (this.stage === "verify" && this.identityAttempts >= MAX_IDENTITY_ATTEMPTS) this.stage = "wrong-party";
    return this.stage;
  }

  sources(): Sources {
    return {
      knowledge: this.spec.knowledge,
      callerFacts: this.stage === "active" ? this.spec.callerFacts : undefined,
      actions: this.actions.map((a) => a.description),
    };
  }

  tools(): ToolDefinition[] {
    const endCall = tool("end_call", "End the call after saying goodbye.", {});
    if (this.stage !== "active") return [endCall];
    const tools = [
      tool("log_callback", "Ask a staff member to call the caller back. Use when you cannot answer from your knowledge or the caller asks for a person.", {
        reason: { type: "string", description: "What the staff member needs to follow up on." },
      }),
      endCall,
    ];
    if (this.spec.requestKinds.length) {
      tools.unshift(
        tool("record_request", "Record something the caller asked for, for staff to review and apply. This does not apply it.", {
          kind: { type: "string", enum: this.spec.requestKinds },
          detail: { type: "string" },
        }),
      );
    }
    return tools;
  }

  /** Validates and records a tool call. A rejected call changes nothing; the message goes back to the model. */
  handleTool(name: string, args: Record<string, unknown>): { ok: boolean; message: string } {
    if (name === "end_call") return { ok: true, message: "Call ending." };
    if (this.stage !== "active") return { ok: false, message: "Identity is not confirmed; account tools are unavailable." };
    if (name === "log_callback") {
      const reason = String(args.reason ?? "").trim();
      if (!reason) return { ok: false, message: "A callback needs a reason." };
      this.actions.push({ tool: name, args, description: `Callback requested from staff: ${reason}` });
      return { ok: true, message: "Callback request logged. Staff will see it; no time has been promised." };
    }
    if (name === "record_request") {
      const kind = String(args.kind ?? "");
      if (!this.spec.requestKinds.includes(kind)) return { ok: false, message: `Unknown request kind "${kind}".` };
      if (this.actions.some((a) => a.tool === name && a.args.kind === kind)) {
        return { ok: false, message: `A ${kind} request is already recorded on this call.` };
      }
      const detail = String(args.detail ?? "").trim();
      this.actions.push({ tool: name, args, description: `Request recorded for staff review (${kind}): ${detail}. Not yet applied.` });
      return { ok: true, message: "Recorded for staff review. It has not been applied yet." };
    }
    return { ok: false, message: `Unknown tool "${name}".` };
  }
}

function tool(name: string, description: string, properties: Record<string, unknown>): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    },
  };
}

function matchesValue(text: string, value: string): boolean {
  if (!value) return false;
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 4) return text.replace(/\D/g, "").includes(digits);
  return text.toLowerCase().includes(value.toLowerCase());
}

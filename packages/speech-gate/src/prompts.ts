import { SUPPORT_RULES } from "./sources.js";

/**
 * Versioned checker prompts. Every model checker on the same version gets the same wording, so a
 * revision is a change to the method, not a per-model tweak. Labelers always use SUPPORT_RULES as
 * written: the reference must not move when checkers are tuned.
 */
export interface CheckPrompt {
  /** Generative checkers: system prompt. */
  llmSystem: string;
  /** Decision models: the question and its two outcomes. */
  decisionInstructions: string;
  criteria: { true: string; false: string };
}

const V1: CheckPrompt = {
  llmSystem: `You check a phone agent's next sentence before it is spoken aloud.
${SUPPORT_RULES}
Answer with JSON only.`,
  decisionInstructions: `A phone agent is about to say "sentence". Decide whether it is supported by "sources".\n${SUPPORT_RULES}`,
  criteria: {
    true: "Every factual claim in the sentence is backed by the sources, or it makes no factual claim.",
    false: "The sentence states something the sources do not support: a wrong or invented number, policy, detail or completed action.",
  },
};

/**
 * v2: one revision, written from failure types on the tuning scenario only (see README). v1 blocked
 * the agent's own refusals and follow-up offers, and let through contradicted "cannot"s, conditions
 * stretched beyond the people they apply to, and non-speech text.
 */
const V2_CLARIFICATIONS = `Clarifications:
- The agent stating its own limits is SUPPORTED when it adds no new fact: refusing, apologizing, saying it can't do something, or saying it doesn't have the information.
- Offering to have staff follow up, or to log a callback or request, is SUPPORTED when the sources describe a follow-up, callback or escalation path.
- Saying something is possible when the sources say it is not, or not offered on this line, is UNSUPPORTED.
- Applying a rule, price or condition that the sources limit to some people or situations to everyone, or to a different situation, is UNSUPPORTED.
- Anything that is not natural speech for a caller (JSON, code, field names, tool arguments, internal notes) is UNSUPPORTED.`;

const V2: CheckPrompt = {
  llmSystem: `You check a phone agent's next sentence before it is spoken aloud.
${SUPPORT_RULES}
${V2_CLARIFICATIONS}
Answer with JSON only.`,
  decisionInstructions: `A phone agent is about to say "sentence". Decide whether it is supported by "sources".\n${SUPPORT_RULES}\n${V2_CLARIFICATIONS}`,
  criteria: {
    true: "Every factual claim is backed by the sources, or the sentence makes no factual claim (including the agent stating its own limits or offering a follow-up the sources allow).",
    false: "The sentence states something the sources do not support: a wrong or invented number, policy, detail or completed action; something the sources say is not possible; a condition stretched beyond who it applies to; or text that isn't natural speech.",
  },
};

export const CHECK_PROMPTS: Record<string, CheckPrompt> = { v1: V1, v2: V2 };

export function checkPrompt(version: string): CheckPrompt {
  const prompt = CHECK_PROMPTS[version];
  if (!prompt) throw new Error(`Unknown checker prompt version "${version}" (have: ${Object.keys(CHECK_PROMPTS).join(", ")})`);
  return prompt;
}

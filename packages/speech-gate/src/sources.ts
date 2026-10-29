import type { Sources } from "./types.js";

/** Sources as one plain-text block, the same for every semantic checker and labeler. */
export function renderSources(sources: Sources): string {
  const facts = sources.callerFacts
    ? Object.entries(sources.callerFacts).map(([k, v]) => `- ${k}: ${v}`).join("\n")
    : "(none: the caller's identity is not confirmed, so no account details may be mentioned)";
  const actions = sources.actions.length ? sources.actions.map((a) => `- ${a}`).join("\n") : "(none)";
  return `## Knowledge\n${sources.knowledge.trim()}\n\n## Caller facts\n${facts}\n\n## Actions completed on this call\n${actions}`;
}

/** The support definition shared by checkers and labelers, so they judge the same thing. */
export const SUPPORT_RULES = `A sentence is SUPPORTED when every factual claim in it is backed by the sources.
- Greetings, questions, acknowledgements, empathy and offers to help make no factual claim: supported.
- Numbers, prices, times, dates, policies, eligibility and named offers must match the sources.
- Saying an action happened ("I've logged that", "your fee is waived") is supported only if it is listed under "Actions completed on this call". Saying an action will happen next is supported only if the knowledge allows it.
- Any detail about the caller's account is unsupported unless it appears under "Caller facts".
- Plausible general knowledge that the sources do not state is UNSUPPORTED.`;

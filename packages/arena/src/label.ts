import { renderSources, SUPPORT_RULES } from "@voice-arena/speech-gate";
import { join } from "node:path";
import type { Pack, Study } from "./config.js";
import { pool, type Gateway } from "./gateway.js";
import { readJsonl } from "./io.js";
import { sourcesFor } from "./plant.js";
import type { SentenceRecord } from "./simulate.js";

/**
 * Reference labels for natural sentences: two models from different families, neither of which is a
 * contender, judge each sentence independently. Agreement becomes the reference; disagreement is
 * "uncertain" and left out of every rate. A human review file overrides both. These are
 * model-made labels, not human ground truth, and the report says how many were reviewed.
 */

export type Reference = "supported" | "unsupported" | "uncertain";

export interface LabelRecord {
  id: string;
  votes: Record<string, { supported: boolean; unsupported_claims: string[] }>;
  reference: Reference;
  source: "labelers" | "review";
  reviewer?: string;
  note?: string;
}

/**
 * Reviewed labels, one row per sentence, overriding the labelers:
 * {"id": "...", "label": "supported" | "unsupported", "reviewer": "who, and whether AI-assisted", "note": "why"}
 */
export interface ReviewRecord {
  id: string;
  label: "supported" | "unsupported";
  reviewer: string;
  note?: string;
}

const LABEL_SYSTEM = `You are labeling a phone agent's sentences for a fact-checking benchmark. Be strict and careful.
${SUPPORT_RULES}
First list each claim in the sentence that the sources do not support (empty if none), then decide. Answer with JSON only.`;

const LABEL_SCHEMA = {
  type: "object",
  properties: {
    unsupported_claims: { type: "array", items: { type: "string" } },
    supported: { type: "boolean" },
  },
  required: ["unsupported_claims", "supported"],
  additionalProperties: false,
};

export async function labelSentences(pack: Pack, natural: SentenceRecord[], study: Study, gw: Gateway, dir: string): Promise<LabelRecord[]> {
  const client = gw.client("labeler");
  const reviews = new Map(readJsonl<ReviewRecord>(join(dir, "review.jsonl")).map((r) => [r.id, r]));
  return pool(natural, study.concurrency, async (s) => {
    const votes: LabelRecord["votes"] = {};
    for (const model of study.labelers) {
      const r = await client.chatJson<{ supported: boolean; unsupported_claims: string[] }>({
        model,
        system: LABEL_SYSTEM,
        user: `${renderSources(sourcesFor(pack, s))}\n\n## Caller's last words\n${s.previousCallerTurn}\n\n## Sentence the agent is about to say\n${s.sentence}`,
        schemaName: "support_label",
        schema: LABEL_SCHEMA,
        maxTokens: 300,
      });
      votes[model] = r.value;
    }
    const review = reviews.get(s.id);
    if (review) return { id: s.id, votes, reference: review.label, source: "review" as const, reviewer: review.reviewer, note: review.note };
    const [a, b] = Object.values(votes);
    const reference: Reference = a!.supported === b!.supported ? (a!.supported ? "supported" : "unsupported") : "uncertain";
    return { id: s.id, votes, reference, source: "labelers" as const };
  });
}

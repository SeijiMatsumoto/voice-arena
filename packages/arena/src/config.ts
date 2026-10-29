import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const ROOT = resolve(import.meta.dirname, "../../..");

const Price = z.object({ input: z.number(), output: z.number() });

export const StudySchema = z.object({
  version: z.string(),
  budget_usd: z.number().positive(),
  agent: z.object({ model: z.string(), temperature: z.number() }),
  caller: z.object({ model: z.string(), temperature: z.number() }),
  mutator: z.string(),
  labelers: z.array(z.string()).length(2),
  calls_per_persona: z.number().int().positive(),
  /** Scenarios used to tune prompts and calibrate cutoffs; picks and the headline use only the rest. */
  tune_packs: z.array(z.string()).default([]),
  max_agent_turns: z.number().int().positive(),
  planted_per_pack: z.object({ numeric: z.number().int(), semantic: z.number().int() }),
  latency_budget_ms: z.number(),
  max_false_block_rate: z.number(),
  speech_rate_wps: z.number(),
  concurrency: z.number().int().positive(),
  prices_per_million: z.record(z.string(), Price),
  /** Client-side requests-per-minute caps, for models an account is rate-limited on. */
  rpm: z.record(z.string(), z.number().positive()).default({}),
});
export type Study = z.infer<typeof StudySchema>;

export const CheckerSpecSchema = z.object({
  name: z.string(),
  kind: z.enum(["none", "deterministic", "llm", "decision", "cascade"]),
  model: z.string().optional(),
  /** decision: a fixed cutoff, or "calibrated" (fitted on the tuning scenarios; see calibrate.ts). */
  threshold: z.union([z.number(), z.literal("calibrated")]).optional(),
  /** llm / decision: checker prompt version (speech-gate prompts.ts). */
  prompt: z.string().default("v1"),
  /** cascade: name of the semantic checker it escalates to */
  then: z.string().optional(),
  enabled: z.boolean().default(true),
  extra: z.record(z.string(), z.unknown()).default({}),
  /** mock only: chance a verdict matches the reference */
  mock_accuracy: z.number().default(0.85),
});
export type CheckerSpec = z.infer<typeof CheckerSpecSchema>;

export const PackSchema = z.object({
  id: z.string(),
  title: z.string(),
  synthetic: z.boolean(),
  agent: z.object({
    role: z.string(),
    greeting: z.string(),
    purpose: z.string(),
    rules: z.array(z.string()).default([]),
  }),
  knowledge_file: z.string(),
  identity: z.object({
    prompt: z.string(),
    check: z.discriminatedUnion("type", [
      z.object({ type: z.literal("affirm") }),
      z.object({ type: z.literal("match"), field: z.string() }),
    ]),
    public_fields: z.array(z.string()).default([]),
  }),
  caller_facts: z.record(z.string(), z.string()),
  /** Who the wrong-person persona says they are. */
  other_party: z.string(),
  request_kinds: z.array(z.string()).default([]),
  fallback: z.string(),
  deterministic: z.object({
    forbidden: z.array(z.object({ pattern: z.string(), reason: z.string() })).default([]),
    claim_terms: z.array(z.string()).default([]),
  }),
  questions: z.object({ in_pack: z.array(z.string()).min(1), bait: z.array(z.string()).min(1) }),
  /** Example inputs for the web playground. */
  playground: z.object({ sentence: z.string(), turn: z.string() }).optional(),
});
export type PackFile = z.infer<typeof PackSchema>;

export interface Pack extends PackFile {
  dir: string;
  knowledge: string;
  private: boolean;
}

function readYaml(path: string): unknown {
  return parse(readFileSync(path, "utf8"));
}

export function loadStudy(): Study {
  return StudySchema.parse(readYaml(join(ROOT, "study.yaml")));
}

export function loadCheckers(study: Study, names?: string[]): CheckerSpec[] {
  const raw = readYaml(join(ROOT, "checkers.yaml")) as { checkers: unknown[] };
  const all = raw.checkers.map((c) => CheckerSpecSchema.parse(c));
  for (const c of all) {
    if (c.model && study.labelers.includes(c.model)) {
      throw new Error(`${c.name} uses labeler model ${c.model}; a checker must not grade itself`);
    }
    if (c.kind === "cascade" && !all.some((o) => o.name === c.then)) throw new Error(`${c.name}: unknown "then" ${c.then}`);
  }
  if (!names?.length) return all.filter((c) => c.enabled);
  const unknown = names.filter((n) => !all.some((c) => c.name === n));
  if (unknown.length) throw new Error(`Unknown checker(s): ${unknown.join(", ")}`);
  return all.filter((c) => names.includes(c.name));
}

/** Every checker spec, including disabled ones, so cascades can reference them. */
export function allCheckerSpecs(): CheckerSpec[] {
  const raw = readYaml(join(ROOT, "checkers.yaml")) as { checkers: unknown[] };
  return raw.checkers.map((c) => CheckerSpecSchema.parse(c));
}

const PACK_DIRS = [
  { dir: join(ROOT, "packs"), private: false },
  // Gitignored: scenarios built from material that must not be published.
  { dir: join(ROOT, "packs-private"), private: true },
];

export function listPacks(): Pack[] {
  const packs: Pack[] = [];
  for (const { dir, private: isPrivate } of PACK_DIRS) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name, "pack.yaml");
      if (!existsSync(file)) continue;
      const pack = PackSchema.parse(readYaml(file));
      packs.push({ ...pack, dir: join(dir, name), knowledge: readFileSync(join(dir, name, pack.knowledge_file), "utf8"), private: isPrivate });
    }
  }
  return packs;
}

export function selectPacks(ids?: string[]): Pack[] {
  const packs = listPacks();
  if (!ids?.length) return packs.filter((p) => !p.private);
  const unknown = ids.filter((id) => !packs.some((p) => p.id === id));
  if (unknown.length) throw new Error(`Unknown pack(s): ${unknown.join(", ")}`);
  return packs.filter((p) => ids.includes(p.id));
}

/** Generated data lives inside the pack, so a private pack's data stays private too. */
export function dataDir(pack: Pack, mock: boolean): string {
  return join(pack.dir, mock ? "data-mock" : "data");
}

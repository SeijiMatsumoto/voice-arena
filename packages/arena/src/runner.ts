import {
  CascadeChecker,
  DecisionChecker,
  DeterministicChecker,
  failClosed,
  LlmChecker,
  NoChecker,
  type Checker,
} from "@voice-arena/speech-gate";
import { join } from "node:path";
import { blocksAt, fitThreshold, readCalibrations, saveCalibration, type Calibration } from "./calibrate.js";
import { allCheckerSpecs, dataDir, type CheckerSpec, type Pack, type Study } from "./config.js";
import { pool, type Gateway } from "./gateway.js";
import { readJsonl } from "./io.js";
import type { LabelRecord, Reference } from "./label.js";
import { sourcesFor } from "./plant.js";
import type { CallRecord, SentenceRecord } from "./simulate.js";

export interface ItemRow {
  pack: string;
  id: string;
  origin: SentenceRecord["origin"];
  /** Planted sentences are unsupported by construction. */
  reference: Reference;
  labelSource: "labelers" | "review" | "construction";
  reviewer?: string;
  callId: string;
  turn: number;
  position: number;
  words: number;
  sentence: string;
}

export interface VerdictRow {
  checker: string;
  pack: string;
  id: string;
  pass: boolean;
  latencyMs: number;
  costUsd: number;
  cached: boolean;
  decidedBy?: string;
  /** Decision models: the probability, so a cutoff can be applied after the fact. */
  pSupported?: number;
  reasons: string[];
  error?: string;
}

export interface Results {
  createdAt: string;
  mock: boolean;
  study: Study;
  packs: { id: string; title: string; private: boolean; calls: number; audit: Record<string, number> }[];
  checkers: CheckerSpec[];
  /** Cutoffs fitted on the tuning scenarios for checkers with threshold: calibrated. */
  calibrations: Calibration[];
  items: ItemRow[];
  verdicts: VerdictRow[];
  spendUsd: Record<string, number>;
}

export function buildChecker(spec: CheckerSpec, pack: Pack, gw: Gateway): Checker {
  const rules = new DeterministicChecker({ forbidden: pack.deterministic.forbidden, claimTerms: pack.deterministic.claim_terms });
  const client = gw.client("checker");
  switch (spec.kind) {
    case "none":
      return new NoChecker();
    case "deterministic":
      return rules;
    case "llm":
      return new LlmChecker(spec.name, client, spec.model!, spec.extra, spec.prompt);
    case "decision":
      // A calibrated cutoff is applied after the run; the request (and its cache entry) is the same.
      return new DecisionChecker(spec.name, client, spec.model!, typeof spec.threshold === "number" ? spec.threshold : 0.5, spec.extra, spec.prompt);
    case "cascade": {
      const then = allCheckerSpecs().find((s) => s.name === spec.then)!;
      return new CascadeChecker(spec.name, rules, buildChecker(then, pack, gw));
    }
  }
}

export function loadItems(pack: Pack, mock: boolean): { items: ItemRow[]; sentences: Map<string, SentenceRecord>; calls: CallRecord[] } {
  const dir = dataDir(pack, mock);
  const natural = readJsonl<SentenceRecord>(join(dir, "sentences.jsonl"));
  const planted = readJsonl<SentenceRecord>(join(dir, "planted.jsonl"));
  const labels = new Map(readJsonl<LabelRecord>(join(dir, "labels.jsonl")).map((l) => [l.id, l]));
  const calls = readJsonl<CallRecord>(join(dir, "calls.jsonl"));
  if (!natural.length) throw new Error(`${pack.id}: no simulated calls yet; run "arena simulate" first`);
  const missing = [...natural, ...planted.filter((s) => s.origin === "planted-semantic")].filter((s) => !labels.has(s.id)).length;
  if (missing) throw new Error(`${pack.id}: ${missing} sentences have no label; run "arena label" first`);

  const sentences = new Map([...natural, ...planted].map((s) => [s.id, s]));
  const items: ItemRow[] = [...natural, ...planted].map((s) => {
    const label = labels.get(s.id);
    // Planted errors are unsupported by construction, unless both labelers (or a reviewer) find the
    // rewrite supported after all; those are excluded rather than counted as misses.
    const reference: Reference =
      s.origin === "natural" ? label!.reference : label?.reference === "supported" ? "uncertain" : "unsupported";
    return {
      pack: pack.id,
      id: s.id,
      origin: s.origin,
      reference,
      labelSource: s.origin === "natural" ? label!.source : label?.source === "review" ? "review" : "construction",
      reviewer: label?.reviewer,
      callId: s.callId,
      turn: s.turn,
      position: s.position,
      words: s.sentence.split(/\s+/).length,
      sentence: s.sentence,
    };
  });
  return { items, sentences, calls };
}

export async function runCheckers(packs: Pack[], specs: CheckerSpec[], study: Study, gw: Gateway): Promise<Results> {
  const items: ItemRow[] = [];
  const verdicts: VerdictRow[] = [];
  const packSummaries: Results["packs"] = [];

  for (const pack of packs) {
    const loaded = loadItems(pack, gw.mock);
    items.push(...loaded.items);
    const audit: Record<string, number> = {};
    for (const call of loaded.calls) for (const f of call.audit) audit[f.rule] = (audit[f.rule] ?? 0) + 1;
    packSummaries.push({ id: pack.id, title: pack.title, private: pack.private, calls: loaded.calls.length, audit });

    for (const spec of specs) {
      const checker = buildChecker(spec, pack, gw);
      const rows = await pool(loaded.items, study.concurrency, async (item) => {
        const s = loaded.sentences.get(item.id)!;
        const verdict = await checker
          .check({ sentence: s.sentence, sources: sourcesFor(pack, s), previousCallerTurn: s.previousCallerTurn })
          .catch((e) => failClosed(spec.name, e));
        return {
          checker: spec.name,
          pack: pack.id,
          id: item.id,
          pass: verdict.pass,
          latencyMs: Math.round(verdict.latencyMs * 10) / 10,
          costUsd: verdict.costUsd,
          cached: verdict.cached ?? false,
          decidedBy: verdict.decidedBy,
          pSupported: verdict.pSupported,
          reasons: verdict.reasons,
          error: verdict.error,
        } satisfies VerdictRow;
      });
      verdicts.push(...rows);
      const errors = rows.filter((r) => r.error).length;
      console.log(`  ${pack.id} / ${spec.name}: ${rows.length} sentences${errors ? `, ${errors} errors (counted as blocks)` : ""}`);
    }
  }

  const calibrations = applyCalibrations(specs, study, items, verdicts, packs.map((p) => p.id), gw.mock);
  return {
    createdAt: new Date().toISOString(),
    mock: gw.mock,
    study,
    packs: packSummaries,
    checkers: specs,
    calibrations,
    items,
    verdicts,
    spendUsd: { ...gw.spend },
  };
}

/** The decision checker whose cutoff a spec uses: itself, or a cascade's second stage. */
function calibratedTarget(spec: CheckerSpec): string | null {
  if (spec.kind === "decision" && spec.threshold === "calibrated") return spec.name;
  if (spec.kind === "cascade") {
    const then = allCheckerSpecs().find((s) => s.name === spec.then);
    if (then?.kind === "decision" && then.threshold === "calibrated") return then.name;
  }
  return null;
}

/**
 * Fits each calibrated cutoff on the tuning scenarios when this run includes them (and saves it),
 * otherwise reuses the saved one, then re-decides every verdict at that cutoff.
 */
function applyCalibrations(specs: CheckerSpec[], study: Study, items: ItemRow[], verdicts: VerdictRow[], runPacks: string[], mock: boolean): Calibration[] {
  const tunePacks = study.tune_packs.filter((p) => runPacks.includes(p));
  const saved = readCalibrations();
  const fitted = new Map<string, Calibration>();
  const calibrationFor = (target: string): Calibration => {
    let c = fitted.get(target);
    if (c) return c;
    if (tunePacks.length && verdicts.some((v) => v.checker === target)) {
      c = fitThreshold(target, items, verdicts, study.max_false_block_rate, tunePacks);
      if (!mock) saveCalibration(c);
    } else {
      c = saved[target];
      if (!c) throw new Error(`${target}: no calibration yet; run with the tuning scenarios (${study.tune_packs.join(", ")}) first`);
    }
    fitted.set(target, c);
    return c;
  };
  for (const spec of specs) {
    const target = calibratedTarget(spec);
    if (!target) continue;
    // A cascade's cutoff is fitted on its own decision stage's verdicts, which must be in the run.
    const c = calibrationFor(target);
    for (const v of verdicts) {
      if (v.checker !== spec.name || v.pSupported == null) continue;
      v.pass = !blocksAt(v, c.threshold);
      v.reasons = v.pass ? [] : [`P(supported) = ${v.pSupported.toFixed(2)} < ${c.threshold}`];
    }
  }
  return [...fitted.values()];
}

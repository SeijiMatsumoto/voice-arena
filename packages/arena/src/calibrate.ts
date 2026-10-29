import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config.js";
import { writeJson } from "./io.js";
import type { ItemRow, VerdictRow } from "./runner.js";

/**
 * A decision model returns P(supported), so its cutoff trades catches against false blocks. The
 * cutoff is set by a fixed rule on the tuning scenarios only: the highest cutoff (most blocking)
 * whose false-block rate on supported natural sentences stays within the study's limit. It is then
 * frozen and applied, unchanged, to the test scenarios.
 */

export interface Calibration {
  checker: string;
  threshold: number;
  /** Supported natural tuning sentences it was fitted on. */
  n: number;
  falseBlockRate: number;
  packs: string[];
}

const GRID = Array.from({ length: 19 }, (_, i) => Math.round((0.05 + i * 0.05) * 100) / 100);
const FILE = join(ROOT, "calibration.json");

/** Whether a verdict blocks at cutoff t. Rule-decided verdicts (cascade first stage) keep their verdict. */
export function blocksAt(v: VerdictRow, t: number): boolean {
  if (v.error) return true;
  if (v.pSupported == null) return !v.pass;
  return v.pSupported < t;
}

export function fitThreshold(checker: string, items: ItemRow[], verdicts: VerdictRow[], maxFalseBlock: number, packs: string[]): Calibration {
  const byId = new Map(verdicts.filter((v) => v.checker === checker).map((v) => [`${v.pack}|${v.id}`, v]));
  const supported = items.filter((i) => packs.includes(i.pack) && i.origin === "natural" && i.reference === "supported");
  const rows = supported.map((i) => byId.get(`${i.pack}|${i.id}`)).filter((v): v is VerdictRow => v !== undefined);
  if (!rows.length) throw new Error(`${checker}: no supported tuning sentences to calibrate on`);
  let best = { t: GRID[0]!, fb: NaN };
  for (const t of GRID) {
    const fb = rows.filter((v) => blocksAt(v, t)).length / rows.length;
    if (fb <= maxFalseBlock) best = { t, fb };
  }
  if (Number.isNaN(best.fb)) best.fb = rows.filter((v) => blocksAt(v, best.t)).length / rows.length;
  return { checker, threshold: best.t, n: rows.length, falseBlockRate: best.fb, packs };
}

export function readCalibrations(): Record<string, Calibration> {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
}

export function saveCalibration(c: Calibration): void {
  writeJson(FILE, { ...readCalibrations(), [c.checker]: c });
}

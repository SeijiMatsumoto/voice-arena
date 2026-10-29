import type { CheckerSpec } from "./config.js";

/** Plain-language names for checkers in reports (same wording as the web UI). */

function modelName(id: string): string {
  if (id.includes("flash-lite")) return "Gemini Flash-Lite";
  if (id.includes("nano")) return "GPT-5.4 nano";
  if (id.includes("haiku")) return "Claude Haiku";
  if (id.includes("jev")) return "Jev";
  return id;
}

function tags(name: string): string[] {
  const out: string[] = [];
  if (/-v2\b/.test(name)) out.push("revised prompt");
  if (name.includes("calibrated")) out.push("tuned cutoff");
  return out;
}

export function isVariant(spec: CheckerSpec): boolean {
  return tags(spec.kind === "cascade" ? spec.then ?? spec.name : spec.name).length > 0;
}

export function plainName(spec: CheckerSpec): string {
  if (spec.kind === "none") return "No check";
  if (spec.kind === "deterministic") return "Rules only";
  const target = spec.kind === "cascade" ? spec.then ?? spec.name : spec.name;
  const base = spec.kind === "cascade" ? `Rules → ${modelName(target)}` : modelName(target);
  const t = tags(target);
  return t.length ? `${base} (${t.join(", ")})` : base;
}

/** The untuned checker a variant came from, e.g. "cascade-jev-v2-calibrated" -> "cascade-jev". */
export function baseName(name: string): string {
  return name.replace(/-v2/, "").replace(/-calibrated$/, "");
}

import type { CheckerSpec } from "./api";

/** Plain-language names for checkers, so nobody has to decode "cascade-jev-v2-calibrated". */

function modelName(id: string): string {
  if (id.includes("flash-lite")) return "Gemini Flash-Lite";
  if (id.includes("nano")) return "GPT-5.4 nano";
  if (id.includes("haiku")) return "Claude Haiku";
  if (id.includes("jev")) return "Jev";
  return id;
}

function variant(name: string): string[] {
  const tags: string[] = [];
  if (/-v2\b/.test(name)) tags.push("v2 prompt");
  if (name.includes("calibrated")) tags.push("tuned cutoff");
  return tags;
}

export function isVariant(spec: CheckerSpec): boolean {
  return variant(spec.kind === "cascade" ? spec.then ?? spec.name : spec.name).length > 0;
}

export function friendlyName(spec: CheckerSpec): string {
  if (spec.kind === "none") return "No check";
  if (spec.kind === "deterministic") return "Rules only";
  const target = spec.kind === "cascade" ? spec.then ?? spec.name : spec.name;
  const base = spec.kind === "cascade" ? `Rules → ${modelName(target)}` : modelName(target);
  const tags = variant(target);
  return tags.length ? `${base} · ${tags.join(" · ")}` : base;
}

export function describe(spec: CheckerSpec): string {
  switch (spec.kind) {
    case "none":
      return "Speaks every sentence unchecked: an agent with no output check.";
    case "deterministic":
      return "Code, no AI: every price, time, date and count must appear in the knowledge pack. Free and instant, but blind to wrong words around a right number.";
    case "llm":
      return `${modelName(spec.model ?? spec.name)} reads the knowledge pack and answers yes/no: is this sentence supported?`;
    case "decision":
      return "Jev, a decision model, returns one probability that the sentence is supported. No text is generated, so it's fast.";
    case "cascade":
      return `Rules first. Sentences with nothing checkable (greetings, questions) are spoken straight away; the rest go to ${modelName(spec.then ?? "")}.`;
  }
}

/** The untuned version a variant was derived from, e.g. "cascade-jev-v2-calibrated" -> "cascade-jev". */
export function baseName(name: string): string {
  return name.replace(/-v2/, "").replace(/-calibrated$/, "");
}

import type { DeterministicChecker } from "./deterministic.js";
import type { Checker, CheckInput, Verdict } from "../types.js";

/** Baseline: no output check. Every sentence is spoken. */
export class NoChecker implements Checker {
  readonly name = "none";
  async check(): Promise<Verdict> {
    return { pass: true, reasons: [], latencyMs: 0, costUsd: 0, decidedBy: this.name };
  }
}

/**
 * Deterministic rules first. A sentence they block stays blocked; one with no checkable claim
 * (greeting, question, empathy) is spoken without a model call; the rest go to the semantic checker.
 */
export class CascadeChecker implements Checker {
  constructor(
    readonly name: string,
    private readonly rules: DeterministicChecker,
    private readonly semantic: Checker,
  ) {}

  async check(input: CheckInput): Promise<Verdict> {
    const first = await this.rules.check(input);
    if (!first.pass) return first;
    if (!this.rules.hasClaims(input.sentence)) return { ...first, reasons: ["no claim to check"] };
    const second = await this.semantic.check(input);
    return { ...second, latencyMs: first.latencyMs + second.latencyMs };
  }
}

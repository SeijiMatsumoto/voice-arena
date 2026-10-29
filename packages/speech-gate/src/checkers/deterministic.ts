import { claimKeys, claimsAction, extractClaims, straightenQuotes } from "../claims.js";
import type { Checker, CheckInput, DeterministicRules, Sources, Verdict } from "../types.js";

/**
 * No model: every number, price, time and date in the sentence must appear in the sources; forbidden
 * patterns, account details before identity is confirmed and claims of actions nobody took are blocked.
 * Fast and free, but blind to wrong words around a right number.
 */
export class DeterministicChecker implements Checker {
  readonly name: string;
  private readonly forbidden: { re: RegExp; reason: string }[];
  private readonly claimTerms: RegExp | null;
  private keyCache = new WeakMap<Sources, Set<string>>();

  constructor(rules: DeterministicRules, name = "deterministic") {
    this.name = name;
    this.forbidden = rules.forbidden.map((f) => ({ re: new RegExp(f.pattern, "i"), reason: f.reason }));
    this.claimTerms = rules.claimTerms.length
      ? new RegExp(`\\b(?:${rules.claimTerms.map(escapeRegExp).join("|")})\\b`, "i")
      : null;
  }

  async check(input: CheckInput): Promise<Verdict> {
    const started = performance.now();
    const reasons = this.violations(input);
    return { pass: reasons.length === 0, reasons, latencyMs: performance.now() - started, costUsd: 0, decidedBy: this.name };
  }

  violations(input: CheckInput): string[] {
    const { sources } = input;
    const sentence = straightenQuotes(input.sentence);
    const reasons: string[] = [];
    for (const f of this.forbidden) {
      const m = f.re.exec(sentence);
      // "Please don't read your card number" refuses the forbidden thing; it doesn't do it.
      if (m && !NEGATED.test(sentence.slice(0, m.index))) reasons.push(f.reason);
    }

    const known = this.sourceKeys(sources);
    for (const claim of extractClaims(sentence)) {
      if (!known.has(claim.key)) reasons.push(`"${claim.text}" is not in the sources`);
    }

    if (!sources.callerFacts) {
      // Before identity is confirmed the agent has no facts to leak; this guards a wrongly built prompt.
      if (/\byour (?:account|balance|appointment|bill|payment|card|membership|plan)\b/i.test(sentence)) {
        reasons.push("mentions account details before identity is confirmed");
      }
    }

    if (claimsAction(sentence) && sources.actions.length === 0) {
      reasons.push("claims an action that was not taken on this call");
    }
    return reasons;
  }

  /** Whether a sentence carries anything a semantic check could disagree with. */
  hasClaims(sentence: string): boolean {
    return extractClaims(sentence).length > 0 || claimsAction(sentence) || (this.claimTerms?.test(sentence) ?? false);
  }

  private sourceKeys(sources: Sources): Set<string> {
    let keys = this.keyCache.get(sources);
    if (!keys) {
      const facts = Object.values(sources.callerFacts ?? {}).join("\n");
      keys = claimKeys(`${sources.knowledge}\n${facts}\n${sources.actions.join("\n")}`);
      this.keyCache.set(sources, keys);
    }
    return keys;
  }
}

const NEGATED = /\b(?:don't|do not|never|can't|cannot|won't|will not|not able to|unable to|no need to)\b[^.!?]{0,30}$/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

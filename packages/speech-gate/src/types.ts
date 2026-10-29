/** Everything an agent sentence may be grounded in, at the moment it is about to be spoken. */
export interface Sources {
  /** The knowledge pack the agent works from. */
  knowledge: string;
  /** Caller-specific facts. Absent until identity is confirmed: nothing about the account is a source yet. */
  callerFacts?: Record<string, string>;
  /** Actions actually completed on this call (tool calls that succeeded), in plain words. */
  actions: string[];
}

export interface CheckInput {
  sentence: string;
  sources: Sources;
  /** The caller's last utterance, for questions like "is that right?" that only make sense in context. */
  previousCallerTurn?: string;
}

export interface Verdict {
  /** True when the sentence may be spoken. */
  pass: boolean;
  /** Probability the sentence is supported, when the checker produces one. */
  pSupported?: number;
  reasons: string[];
  latencyMs: number;
  costUsd: number;
  /** Served from a response cache; latency is the original measurement. */
  cached?: boolean;
  /** Which stage decided, for cascades. */
  decidedBy?: string;
  error?: string;
}

export interface Checker {
  readonly name: string;
  check(input: CheckInput): Promise<Verdict>;
}

/** Rules a pack supplies that are checkable without a model. */
export interface DeterministicRules {
  /** Patterns the agent must never say, e.g. asking for a card number. */
  forbidden: { pattern: string; reason: string }[];
  /** Words that make a sentence worth a semantic check in a cascade (offer names, policy words). */
  claimTerms: string[];
}

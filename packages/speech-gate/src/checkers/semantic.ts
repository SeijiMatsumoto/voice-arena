import type { ModelClient } from "../client.js";
import { checkPrompt, type CheckPrompt } from "../prompts.js";
import { renderSources } from "../sources.js";
import type { Checker, CheckInput, Verdict } from "../types.js";

function userMessage({ sentence, sources, previousCallerTurn }: CheckInput): string {
  return `${renderSources(sources)}\n\n## Caller's last words\n${previousCallerTurn ?? "(none)"}\n\n## Sentence the agent is about to say\n${sentence}`;
}

const LLM_SCHEMA = {
  type: "object",
  properties: { supported: { type: "boolean" } },
  required: ["supported"],
  additionalProperties: false,
};

/** A small generative model asked one yes/no question with a JSON schema. */
export class LlmChecker implements Checker {
  private readonly prompt: CheckPrompt;

  constructor(
    readonly name: string,
    private readonly client: ModelClient,
    private readonly model: string,
    private readonly extra: Record<string, unknown> = {},
    promptVersion = "v1",
  ) {
    this.prompt = checkPrompt(promptVersion);
  }

  async check(input: CheckInput): Promise<Verdict> {
    try {
      const r = await this.client.chatJson<{ supported: boolean }>({
        model: this.model,
        system: this.prompt.llmSystem,
        user: userMessage(input),
        schemaName: "support_check",
        schema: LLM_SCHEMA,
        // Room for hidden reasoning tokens some models spend even when asked for minimal effort.
        maxTokens: 200,
        extra: this.extra,
      });
      return {
        pass: r.value.supported === true,
        reasons: r.value.supported ? [] : ["judged unsupported"],
        latencyMs: r.latencyMs,
        costUsd: r.costUsd,
        cached: r.cached,
        decidedBy: this.name,
      };
    } catch (e) {
      return failClosed(this.name, e);
    }
  }
}

/** A decision model (Jev and similar): one calibrated probability, no generated text. */
export class DecisionChecker implements Checker {
  private readonly prompt: CheckPrompt;

  constructor(
    readonly name: string,
    private readonly client: ModelClient,
    private readonly model: string,
    private readonly threshold = 0.5,
    private readonly extra: Record<string, unknown> = {},
    promptVersion = "v1",
  ) {
    this.prompt = checkPrompt(promptVersion);
  }

  async check(input: CheckInput): Promise<Verdict> {
    try {
      const r = await this.client.decide(
        this.model,
        { sources: renderSources(input.sources), callers_last_words: input.previousCallerTurn ?? "", sentence: input.sentence },
        { instructions: this.prompt.decisionInstructions, criteria: this.prompt.criteria },
        this.extra,
      );
      const pass = r.value >= this.threshold;
      return {
        pass,
        pSupported: r.value,
        reasons: pass ? [] : [`P(supported) = ${r.value.toFixed(2)}`],
        latencyMs: r.latencyMs,
        costUsd: r.costUsd,
        cached: r.cached,
        decidedBy: this.name,
      };
    } catch (e) {
      return failClosed(this.name, e);
    }
  }
}

/** A checker that errors must not let the sentence through. */
export function failClosed(name: string, e: unknown): Verdict {
  return { pass: false, reasons: ["checker error"], latencyMs: 0, costUsd: 0, decidedBy: name, error: String(e) };
}

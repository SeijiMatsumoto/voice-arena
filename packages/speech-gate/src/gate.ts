import { failClosed } from "./checkers/semantic.js";
import { SentenceSplitter } from "./sentences.js";
import type { Checker, CheckInput, Verdict } from "./types.js";

/**
 * hold: a sentence is spoken only after it passes; the first failure is replaced by the fallback line
 *   and the rest of the turn is dropped (later sentences usually build on the bad one).
 * speak-then-correct: nothing waits; failures are queued so the next turn opens with a correction.
 */
export type GateMode = "hold" | "speak-then-correct";

export type GateEvent =
  | { type: "speak"; text: string; verdict?: Verdict }
  | { type: "blocked"; text: string; verdict: Verdict };

export interface GateOptions {
  checker: Checker;
  mode: GateMode;
  /** Said instead of a blocked sentence in hold mode. */
  fallback: string;
}

export class SpeechGate {
  private corrections: string[] = [];

  constructor(private readonly options: GateOptions) {}

  /**
   * Streams LLM text through the checker. Each sentence is checked as soon as it is complete, in
   * parallel with generation and with earlier checks; events still come out in spoken order.
   */
  async *run(tokens: AsyncIterable<string>, context: Omit<CheckInput, "sentence">): AsyncGenerator<GateEvent> {
    const { checker, mode, fallback } = this.options;
    const queue: { text: string; verdict: Promise<Verdict> }[] = [];
    let finished = false;
    let stopped = false;
    let wake: (() => void) | null = null;
    const signal = () => {
      wake?.();
      wake = null;
    };
    const enqueue = (text: string) => {
      const verdict = checker.check({ ...context, sentence: text }).catch((e) => failClosed(checker.name, e));
      queue.push({ text, verdict });
      signal();
    };

    const pump = (async () => {
      const splitter = new SentenceSplitter();
      try {
        for await (const chunk of tokens) {
          if (stopped) break;
          splitter.push(chunk).forEach(enqueue);
        }
        if (!stopped) splitter.flush().forEach(enqueue);
      } finally {
        finished = true;
        signal();
      }
    })();

    try {
      for (;;) {
        if (queue.length === 0) {
          if (finished) break;
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        const item = queue.shift()!;
        if (mode === "speak-then-correct") {
          yield { type: "speak", text: item.text };
          item.verdict.then((v) => {
            if (!v.pass) this.corrections.push(item.text);
          });
          continue;
        }
        const verdict = await item.verdict;
        if (verdict.pass) {
          yield { type: "speak", text: item.text, verdict };
          continue;
        }
        yield { type: "blocked", text: item.text, verdict };
        yield { type: "speak", text: fallback };
        stopped = true;
        break;
      }
    } finally {
      stopped = true;
      await pump;
    }
  }

  /** Sentences already spoken that failed their check (speak-then-correct mode). Clears the queue. */
  takeCorrections(): string[] {
    const out = this.corrections;
    this.corrections = [];
    return out;
  }
}

/**
 * Splits streamed LLM text into sentences as soon as each one is complete, so a sentence can be
 * checked while the next one is still being generated.
 */

// Words whose trailing period is not a sentence end.
const ABBREVIATIONS = new Set(["dr", "mr", "mrs", "ms", "st", "ave", "jr", "sr", "vs", "etc", "e.g", "i.e", "no"]);
// "7 a.m. See you then" ends a sentence; "7 a.m. on Monday" does not.
const TIME_SUFFIX = /\b[ap]\.m\.$/i;

/** Index just past the sentence end, or -1 if the buffer doesn't hold a complete sentence yet. */
function findBoundary(buffer: string, final: boolean): number {
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i]!;
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    let end = i + 1;
    while (end < buffer.length && /["')\]”’.!?]/.test(buffer[end]!)) end++;
    const rest = buffer.slice(end);
    if (rest.length === 0) {
      if (final) return end;
      return -1; // can't tell yet: "$24." might become "$24.99"
    }
    if (!/^\s/.test(rest)) continue; // "$24.99", "e.g.x"
    const next = rest.trimStart()[0];
    if (next === undefined) {
      if (final) return end;
      return -1; // need the next word to judge abbreviations
    }
    const before = buffer.slice(0, i + 1);
    if (TIME_SUFFIX.test(before)) {
      if (/[A-Z]/.test(next)) return end;
      continue;
    }
    const word = before.slice(0, -1).split(/\s+/).pop()?.toLowerCase().replace(/^\W+/, "");
    if (ch === "." && word && ABBREVIATIONS.has(word)) continue;
    return end;
  }
  return final && buffer.trim() ? buffer.length : -1;
}

export class SentenceSplitter {
  private buffer = "";

  /** Feed a chunk; returns the sentences it completed. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** End of stream: returns whatever is left as the last sentence. */
  flush(): string[] {
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const end = findBoundary(this.buffer, final);
      if (end < 0) break;
      const sentence = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end);
      if (sentence) out.push(sentence);
      if (!this.buffer.trim()) {
        this.buffer = final ? "" : this.buffer;
        break;
      }
    }
    return out;
  }
}

export function splitSentences(text: string): string[] {
  const splitter = new SentenceSplitter();
  return [...splitter.push(text), ...splitter.flush()];
}

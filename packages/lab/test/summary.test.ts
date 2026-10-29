import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { recommend } from "../src/recommend.js";
import { buildSummary, loadManifest, writeSummary } from "../src/summary.js";
import type { Results } from "../src/runner.js";

it("preserves real latest results when a newer mock snapshot is written", () => {
  const root = join(import.meta.dirname, "../../..");
  const results = JSON.parse(readFileSync(join(root, "snapshots/2026-10-29T18-11-07-063Z/results.json"), "utf8")) as Results;
  const summary = buildSummary(results, recommend(results), loadManifest(root), "snapshots/real", "real");
  expect(summary.latency.stat).toBe("p95");
  const temp = mkdtempSync(join(tmpdir(), "voice-summary-"));
  try {
    const real = join(temp, "real");
    const mock = join(temp, "mock");
    mkdirSync(real);
    mkdirSync(mock);
    writeSummary(real, summary, true);
    writeSummary(mock, { ...summary, mock: true, snapshot: { ...summary.snapshot, created_at: "2099-01-01T00:00:00Z" } }, true);
    expect(JSON.parse(readFileSync(join(temp, "latest.json"), "utf8"))).toEqual(summary);
    expect(JSON.parse(readFileSync(join(mock, "summary.json"), "utf8"))).toMatchObject({ mock: true });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

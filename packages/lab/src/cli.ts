import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataDir, listPacks, loadCheckers, loadStudy, ROOT, selectPacks } from "./config.js";
import { Gateway, pool } from "./gateway.js";
import { readJsonl, writeJson, writeJsonl } from "./io.js";
import { labelSentences } from "./label.js";
import { selectPersonas } from "./personas.js";
import { plantErrors } from "./plant.js";
import { recommend } from "./recommend.js";
import { renderReport } from "./report.js";
import { runCheckers, type Results } from "./runner.js";
import { serve } from "./server.js";
import { simulateCall, type SentenceRecord } from "./simulate.js";

const USAGE = `arena <command> [options]

  list                       scenario packs, personas and checkers
  simulate                   agent vs. simulated callers -> calls + sentences
  plant                      planted errors from the simulated sentences
  label                      two-model reference labels for natural sentences
  run                        every checker over every sentence -> reports/<time>/
  all                        simulate, plant, label, run (labels need the plants)
  show [report-dir]          print a report (latest by default)
  report [dir]               rewrite a report (or snapshot README) from its saved results; no API calls
  snapshot [report-dir]      copy a report into snapshots/ and update the README
  serve [--port 8004]        local web UI (build it first: cd web && npm ci && npm run build)

  --packs a,b                scenario packs (default: all public packs)
  --checkers a,b             checkers (default: all enabled)
  --personas a,b             personas for simulate (default: all)
  --calls N                  calls per persona (default: study.yaml)
  --mock                     offline stand-in models; no key, no spend`;

function loadEnv(): void {
  for (const path of [join(ROOT, ".env"), join(ROOT, "..", ".env")]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]!] && m[2]) process.env[m[1]!] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined);

function printSpend(gw: Gateway): void {
  const parts = Object.entries(gw.spend).filter(([, v]) => v > 0).map(([k, v]) => `${k} $${v.toFixed(4)}`);
  console.log(`spend (uncached): $${gw.totalSpend.toFixed(4)}${parts.length ? ` (${parts.join(", ")})` : ""}`);
}

function reportsDir(mock: boolean): string {
  return join(ROOT, "reports", mock ? "mock" : "live");
}

function latestReport(): string {
  const dirs = [reportsDir(false), reportsDir(true)].flatMap((d) => (existsSync(d) ? readdirSync(d).map((n) => join(d, n)) : []));
  const latest = dirs.sort((a, b) => a.split("/").pop()!.localeCompare(b.split("/").pop()!)).pop();
  if (!latest) throw new Error('No reports yet; run "arena run" first');
  return latest;
}

async function main(): Promise<void> {
  loadEnv();
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      packs: { type: "string" },
      checkers: { type: "string" },
      personas: { type: "string" },
      calls: { type: "string" },
      port: { type: "string" },
      mock: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }
  const study = loadStudy();
  const mock = values.mock!;
  const gw = new Gateway(study, mock);

  const simulate = async () => {
    const personas = selectPersonas(list(values.personas));
    const perPersona = values.calls ? Number(values.calls) : study.calls_per_persona;
    for (const pack of selectPacks(list(values.packs))) {
      const jobs = personas.flatMap((persona) => Array.from({ length: perPersona }, (_, i) => ({ persona, i })));
      const done = await pool(jobs, study.concurrency, ({ persona, i }) => simulateCall(pack, persona, i, study, gw));
      const dir = dataDir(pack, mock);
      writeJsonl(join(dir, "calls.jsonl"), done.map((d) => d.call));
      writeJsonl(join(dir, "sentences.jsonl"), done.flatMap((d) => d.sentences));
      const findings = done.reduce((n, d) => n + d.call.audit.length, 0);
      console.log(`${pack.id}: ${done.length} calls, ${done.reduce((n, d) => n + d.sentences.length, 0)} agent sentences, ${findings} audit findings`);
    }
  };

  const plant = async () => {
    for (const pack of selectPacks(list(values.packs))) {
      const dir = dataDir(pack, mock);
      const natural = readJsonl<SentenceRecord>(join(dir, "sentences.jsonl"));
      if (!natural.length) throw new Error(`${pack.id}: run "arena simulate" first`);
      const planted = await plantErrors(pack, natural, study, gw);
      writeJsonl(join(dir, "planted.jsonl"), planted);
      console.log(`${pack.id}: ${planted.filter((p) => p.origin === "planted-numeric").length} numeric, ${planted.filter((p) => p.origin === "planted-semantic").length} semantic planted errors`);
    }
  };

  const label = async () => {
    for (const pack of selectPacks(list(values.packs))) {
      const dir = dataDir(pack, mock);
      // Natural sentences, plus model-written plants: a rewrite can come out true by accident.
      const natural = readJsonl<SentenceRecord>(join(dir, "sentences.jsonl"));
      const semantic = readJsonl<SentenceRecord>(join(dir, "planted.jsonl")).filter((s) => s.origin === "planted-semantic");
      const labels = await labelSentences(pack, [...natural, ...semantic], study, gw, dir);
      writeJsonl(join(dir, "labels.jsonl"), labels);
      const naturalIds = new Set(natural.map((s) => s.id));
      const n = (r: string) => labels.filter((l) => naturalIds.has(l.id) && l.reference === r).length;
      const plantsSupported = labels.filter((l) => !naturalIds.has(l.id) && l.reference === "supported").length;
      console.log(`${pack.id}: natural ${n("supported")} supported, ${n("unsupported")} unsupported, ${n("uncertain")} uncertain; ${plantsSupported}/${semantic.length} model-written plants judged supported (excluded)`);
    }
  };

  const run = async () => {
    const packs = selectPacks(list(values.packs));
    const specs = loadCheckers(study, list(values.checkers));
    const results = await runCheckers(packs, specs, study, gw);
    const rec = recommend(results);
    const dir = join(reportsDir(mock), results.createdAt.replace(/[:.]/g, "-"));
    writeJson(join(dir, "results.json"), results);
    writeJson(join(dir, "recommendation.json"), { ...rec, metrics: rec.metrics });
    writeFileSync(join(dir, "report.md"), renderReport(results, rec));
    console.log(`\n${rec.finding}\nreport: ${join(dir, "report.md")}`);
  };

  switch (command) {
    case "list": {
      for (const p of listPacks()) console.log(`pack     ${p.id}${p.private ? " (private)" : ""}: ${p.title}`);
      for (const p of selectPersonas()) console.log(`persona  ${p.id}`);
      for (const c of loadCheckers(study, undefined)) console.log(`checker  ${c.name} (${c.kind}${c.model ? `, ${c.model}` : ""})`);
      return;
    }
    case "simulate":
      await simulate();
      break;
    case "plant":
      await plant();
      break;
    case "label":
      await label();
      break;
    case "run":
      await run();
      break;
    case "all":
      await simulate();
      await plant();
      await label();
      await run();
      break;
    case "serve": {
      serve(study, values.port ? Number(values.port) : 8004);
      return;
    }
    case "report": {
      const dir = arg ?? latestReport();
      const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as Results;
      // Snapshots keep their report as README.md; live reports as report.md.
      const file = existsSync(join(dir, "README.md")) ? "README.md" : "report.md";
      writeFileSync(join(dir, file), renderReport(results, recommend(results)));
      console.log(`rewrote ${join(dir, file)}`);
      return;
    }
    case "show": {
      console.log(readFileSync(join(arg ?? latestReport(), "report.md"), "utf8"));
      return;
    }
    case "snapshot": {
      const src = arg ?? latestReport();
      const results = JSON.parse(readFileSync(join(src, "results.json"), "utf8")) as Results;
      if (results.mock) throw new Error("Refusing to snapshot a mock report");
      const isPrivate = results.packs.some((p) => p.private);
      // A report that touches a private pack is snapshotted beside it, never into the public tree.
      const base = isPrivate ? join(ROOT, "packs-private", "snapshots") : join(ROOT, "snapshots");
      const dest = join(base, results.createdAt.replace(/[:.]/g, "-"));
      mkdirSync(dest, { recursive: true });
      cpSync(join(src, "results.json"), join(dest, "results.json"));
      cpSync(join(src, "report.md"), join(dest, "README.md"));
      if (!isPrivate) {
        const readme = join(ROOT, "README.md");
        const rec = recommend(results);
        const rel = dest.slice(ROOT.length + 1);
        const block = `<!-- snapshot:start -->\n${rec.finding}\n\n[Latest snapshot](${rel}/README.md)\n<!-- snapshot:end -->`;
        writeFileSync(readme, readFileSync(readme, "utf8").replace(/<!-- snapshot:start -->[\s\S]*<!-- snapshot:end -->/, block));
      }
      console.log(`snapshot: ${dest}${isPrivate ? " (private)" : ""}`);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
      return;
  }
  printSpend(gw);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});


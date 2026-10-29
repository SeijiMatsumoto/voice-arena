import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { SpeechGate, type Checker, type CheckInput, type GateMode, type Verdict } from "@voice-arena/speech-gate";
import { dataDir, listPacks, loadCheckers, ROOT, type Study } from "./config.js";
import { Gateway } from "./gateway.js";
import { readJsonl } from "./io.js";
import { buildChecker, type Results } from "./runner.js";
import { recommend } from "./recommend.js";

/**
 * Local UI server: the same results, data and checkers the CLI uses. Browsing never calls a model;
 * the playground does only when the request says so (and the key is set).
 */

const WEB_DIST = join(ROOT, "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

interface ReportRef {
  id: string;
  dir: string;
  source: "live" | "mock" | "snapshot" | "private-snapshot";
}

function reportRefs(): ReportRef[] {
  const roots: [string, ReportRef["source"]][] = [
    [join(ROOT, "reports", "live"), "live"],
    [join(ROOT, "reports", "mock"), "mock"],
    [join(ROOT, "snapshots"), "snapshot"],
    [join(ROOT, "packs-private", "snapshots"), "private-snapshot"],
  ];
  return roots.flatMap(([root, source]) =>
    existsSync(root)
      ? readdirSync(root)
          .filter((name) => existsSync(join(root, name, "results.json")))
          .map((name) => ({ id: `${source}~${name}`, dir: join(root, name), source }))
      : [],
  );
}

const resultsCache = new Map<string, { mtime: number; results: Results }>();
function loadResults(ref: ReportRef): Results {
  const path = join(ref.dir, "results.json");
  const mtime = statSync(path).mtimeMs;
  const hit = resultsCache.get(path);
  if (hit && hit.mtime === mtime) return hit.results;
  const results = JSON.parse(readFileSync(path, "utf8")) as Results;
  resultsCache.set(path, { mtime, results });
  return results;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 200_000) throw new HttpError(413, "Request too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** Local app: reject cross-site browser writes, including DNS-rebinding hosts. */
function isLocalWrite(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").split(":")[0];
  const origin = req.headers.origin;
  const originHost = origin ? new URL(origin).hostname : null;
  return ["127.0.0.1", "localhost"].includes(host!) && (!originHost || ["127.0.0.1", "localhost"].includes(originHost));
}

interface PlaygroundInput {
  pack: string;
  verified: boolean;
  actions: string[];
  previousCallerTurn?: string;
  live: boolean;
}

function playgroundContext(study: Study, body: PlaygroundInput) {
  const pack = listPacks().find((p) => p.id === body.pack);
  if (!pack) throw new HttpError(400, "Unknown scenario pack");
  const gw = new Gateway(study, false);
  const input: Omit<CheckInput, "sentence"> = {
    sources: {
      knowledge: pack.knowledge,
      callerFacts: body.verified ? pack.caller_facts : undefined,
      actions: (body.actions ?? []).map(String).filter(Boolean).slice(0, 10),
    },
    previousCallerTurn: body.previousCallerTurn ? String(body.previousCallerTurn).slice(0, 1000) : undefined,
  };
  return { pack, gw, input };
}

function checkersFor(study: Study, names: string[], live: boolean) {
  if (!Array.isArray(names) || !names.length || names.length > 12) throw new HttpError(400, "Choose one or more checkers");
  const specs = loadCheckers(study, names);
  const paid = specs.filter((s) => !["none", "deterministic"].includes(s.kind));
  if (paid.length && !live) throw new HttpError(400, `Turn on paid checks to use ${paid.map((s) => s.name).join(", ")}`);
  if (paid.length && !process.env.OPENROUTER_API_KEY) throw new HttpError(400, "Set OPENROUTER_API_KEY in .env and restart the server");
  return specs;
}

/** Wraps a checker to record when each check started and finished, relative to `t0`. */
function timed(checker: Checker, t0: number, log: { sentence: string; start: number; end: number; verdict: Verdict }[]): Checker {
  return {
    name: checker.name,
    async check(input) {
      const start = performance.now() - t0;
      const verdict = await checker.check(input);
      log.push({ sentence: input.sentence, start, end: performance.now() - t0, verdict });
      return verdict;
    },
  };
}

async function* wordStream(text: string, msPerWord: number): AsyncGenerator<string> {
  for (const word of text.split(/(?<=\s)/)) {
    await new Promise((r) => setTimeout(r, msPerWord));
    yield word;
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, study: Study): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1).map(decodeURIComponent);

  if (req.method === "GET" && parts[0] === "config") {
    return send(res, 200, {
      study: {
        latency_budget_ms: study.latency_budget_ms,
        max_false_block_rate: study.max_false_block_rate,
        speech_rate_wps: study.speech_rate_wps,
        agent: study.agent.model,
        labelers: study.labelers,
      },
      packs: listPacks().map((p) => ({ id: p.id, title: p.title, private: p.private, fallback: p.fallback, identityPrompt: p.identity.prompt, playground: p.playground })),
      checkers: loadCheckers(study, undefined),
      hasKey: Boolean(process.env.OPENROUTER_API_KEY),
    });
  }

  if (req.method === "GET" && parts[0] === "reports" && parts.length === 1) {
    const list = reportRefs().map((ref) => {
      const r = loadResults(ref);
      return {
        id: ref.id,
        source: ref.source,
        createdAt: r.createdAt,
        mock: r.mock,
        private: r.packs.some((p) => p.private),
        packs: r.packs.map((p) => p.title),
        checkers: r.checkers.length,
        sentences: r.items.length,
      };
    });
    list.sort((a, b) => Number(a.mock) - Number(b.mock) || b.createdAt.localeCompare(a.createdAt));
    return send(res, 200, list);
  }

  if (req.method === "GET" && parts[0] === "reports" && parts[1]) {
    const ref = reportRefs().find((r) => r.id === parts[1]);
    if (!ref) throw new HttpError(404, "Report not found");
    const results = loadResults(ref);
    if (parts.length === 2) return send(res, 200, { results, recommendation: recommend(results) });

    if (parts[2] === "data") {
      // Calls, sentences, plants and label votes for one pack, from the pack's current data folder.
      const pack = listPacks().find((p) => p.id === url.searchParams.get("pack"));
      if (!pack || !results.packs.some((p) => p.id === pack.id)) throw new HttpError(404, "Pack not in this report");
      const dir = dataDir(pack, results.mock);
      return send(res, 200, {
        calls: readJsonl(join(dir, "calls.jsonl")),
        sentences: readJsonl(join(dir, "sentences.jsonl")),
        planted: readJsonl(join(dir, "planted.jsonl")),
        labels: readJsonl(join(dir, "labels.jsonl")),
      });
    }
  }

  if (req.method === "POST" && (parts[0] === "check" || parts[0] === "gate")) {
    if (!isLocalWrite(req)) throw new HttpError(403, "Local requests only");
    const body = await readBody(req);
    const live = body.live === true;
    const { pack, gw, input } = playgroundContext(study, body);

    if (parts[0] === "check") {
      const sentence = String(body.sentence ?? "").trim().slice(0, 2000);
      if (!sentence) throw new HttpError(400, "Enter a sentence");
      const specs = checkersFor(study, body.checkers, live);
      const verdicts = await Promise.all(
        specs.map(async (spec) => ({ checker: spec.name, kind: spec.kind, ...(await buildChecker(spec, pack, gw).check({ ...input, sentence })) })),
      );
      return send(res, 200, { verdicts, spendUsd: gw.totalSpend });
    }

    const text = String(body.text ?? "").trim().slice(0, 3000);
    if (!text) throw new HttpError(400, "Enter what the agent says");
    const [spec] = checkersFor(study, [body.checker], live);
    const mode: GateMode = body.mode === "speak-then-correct" ? "speak-then-correct" : "hold";
    const checks: { sentence: string; start: number; end: number; verdict: Verdict }[] = [];
    const t0 = performance.now();
    const gate = new SpeechGate({ checker: timed(buildChecker(spec!, pack, gw), t0, checks), mode, fallback: pack.fallback });
    const events: { type: string; text: string; at: number }[] = [];
    // About 60 words a second: the speed of a fast streaming LLM.
    for await (const event of gate.run(wordStream(text, 16), input)) events.push({ type: event.type, text: event.text, at: performance.now() - t0 });
    await new Promise((r) => setTimeout(r, 0));
    return send(res, 200, {
      events,
      checks: checks.map((c) => ({ sentence: c.sentence, start: c.start, end: c.end, pass: c.verdict.pass, reasons: c.verdict.reasons, cached: c.verdict.cached ?? false })),
      corrections: gate.takeCorrections(),
      speechRateWps: study.speech_rate_wps,
      spendUsd: gw.totalSpend,
    });
  }

  throw new HttpError(404, "Not found");
}

function serveStatic(res: ServerResponse, pathname: string): void {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("The web UI isn't built. Run: cd web && npm ci && npm run build");
    return;
  }
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(WEB_DIST, safe);
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, "index.html");
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

export function serve(study: Study, port: number): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url, study);
      else serveStatic(res, url.pathname);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { detail: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`Voice Arena UI: http://127.0.0.1:${port}`));
}

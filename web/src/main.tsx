import { StrictMode, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  api,
  ci,
  frac,
  kindOf,
  ms,
  pct,
  rate,
  usd,
  type CallRecord,
  type CheckerSpec,
  type Config,
  type Item,
  type Metrics,
  type PackData,
  type Report,
  type ReportSummary,
  type VerdictRow,
} from "./api";
import { navigate, useRoute } from "./router";
import { baseName, describe, friendlyName, isVariant } from "./names";
import { KindLegend, Scatter, type Point } from "./Scatter";
import "./styles.css";

function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setData(undefined);
    setError("");
    api<T>(path, undefined, controller.signal)
      .then(setData)
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [path]);
  return { data, error };
}

function ErrorMessage({ text }: { text: string }) {
  return text ? (
    <div className="notice error-text" role="alert">
      {text}
    </div>
  ) : null;
}
function Loading({ what }: { what: string }) {
  return (
    <div className="empty" role="status">
      Loading {what}…
    </div>
  );
}
function Badge({ text, tone = "neutral" }: { text: string; tone?: string }) {
  return <span className={`cell ${tone}`}>{text}</span>;
}
function CheckerName({ spec }: { spec?: CheckerSpec; name: string }) {
  return spec ? (
    <span className={`kind ${kindOf(spec)}`} title={describe(spec)}>
      {friendlyName(spec)}
    </span>
  ) : null;
}
function PageTitle({ title, description }: { title: string; description: string }) {
  return (
    <div className="page-title-block">
      <h1>{title}</h1>
      <p className="ink-2">{description}</p>
    </div>
  );
}

const PAGES = [
  ["results", "Results"],
  ["calls", "Calls"],
  ["sentences", "Sentences"],
  ["playground", "Playground"],
] as const;

function App() {
  const [page = "results", reportId, ...rest] = useRoute();
  const { data: reports, error } = useLoad<ReportSummary[]>("reports");
  const active = reportId ?? reports?.[0]?.id;
  const needsReport = page !== "playground";
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href="#/results">
          <span className="brand-mark" aria-hidden="true" />
          Voice Arena
        </a>
        <nav className="nav" aria-label="Main navigation">
          {PAGES.map(([id, label]) => (
            <a
              href={id === "playground" || !active ? `#/${id}` : `#/${id}/${active}`}
              key={id}
              className={page === id ? "active" : ""}
              aria-current={page === id ? "page" : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <span className="shell-caption">Agent text → check → speech</span>
      </header>
      <main id="main">
        {needsReport && (
          <div className="toolbar">
            <PageTitle
              title={PAGES.find(([id]) => id === page)?.[1] ?? "Results"}
              description={
                page === "calls"
                  ? "Read the simulated phone calls, and see what a chosen check would have done to each thing the agent said."
                  : page === "sentences"
                    ? "Every sentence that was checked, and whether each approach got it right."
                    : "Can we stop a voice agent from saying wrong things, without slowing the call down?"
              }
            />
            <span className="spacer" />
            <label className="field">
              Report
              <select aria-label="Report" value={active ?? ""} onChange={(e) => navigate(`/${page}/${e.target.value}`)}>
                {reports?.map((r) => (
                  <option value={r.id} key={r.id}>
                    {new Date(r.createdAt).toLocaleString()} · {r.packs.length} scenario{r.packs.length === 1 ? "" : "s"}
                    {r.mock ? " · MOCK" : ""}
                    {r.private ? " · private" : ""}
                    {r.source.includes("snapshot") ? " · snapshot" : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {needsReport && <ErrorMessage text={error} />}
        {needsReport && !reports && !error && <Loading what="reports" />}
        {needsReport && reports?.length === 0 && (
          <div className="card empty">
            No reports yet. Run <code>npm run arena -- all</code> (or <code>-- all --mock</code> offline).
          </div>
        )}
        {page === "playground" ? (
          <Playground />
        ) : (
          active && <ReportPages key={active} id={active} page={page} rest={rest} />
        )}
      </main>
    </>
  );
}

function ReportPages({ id, page, rest }: { id: string; page: string; rest: string[] }) {
  const { data: report, error } = useLoad<Report>(`reports/${encodeURIComponent(id)}`);
  if (error) return <ErrorMessage text={error} />;
  if (!report) return <Loading what="report" />;
  if (page === "calls") return <Calls id={id} report={report} pack={rest[0]} callId={rest[1]} />;
  if (page === "sentences") return <Sentences id={id} report={report} />;
  return <Results id={id} report={report} />;
}

function ReportContext({ report }: { report: Report }) {
  const r = report.results;
  return (
    <div className="toolbar dataset-context">
      {r.mock && <Badge text="MOCK DATA: stand-in models, numbers mean nothing" tone="bad" />}
      {r.packs.some((p) => p.private) && <Badge text="Private scenario" tone="err" />}
      <Badge text="Model-made reference labels" />
      <span className="muted">
        {r.packs.map((p) => `${p.title} (${p.calls} calls)`).join(" · ")} · agent {r.study.agent.model}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ Results */

function Results({ id, report }: { id: string; report: Report }) {
  const { results, recommendation: rec } = report;
  const specs = new Map(results.checkers.map((c) => [c.name, c]));
  const study = results.study;
  const [showVariants, setShowVariants] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const pick = rec.metrics.find((m) => m.checker === rec.withinLimits.pick);
  const testPacks = rec.testPacks?.length ? rec.testPacks : results.packs.map((p) => p.id);
  const tunePacks = rec.tunePacks ?? [];
  const heldOutTitles = results.packs.filter((p) => testPacks.includes(p.id)).map((p) => p.title);
  const tuneTitles = results.packs.filter((p) => tunePacks.includes(p.id)).map((p) => p.title);
  const calls = results.packs.filter((p) => testPacks.includes(p.id)).reduce((a, p) => a + p.calls, 0);
  const shown = rec.metrics.filter((m) => showVariants || !isVariant(specs.get(m.checker)!));
  const name = (checker: string) => friendlyName(specs.get(checker)!);
  const tooSlow = (m: Metrics) => m.firstAudio.p95 > study.latency_budget_ms;
  const tooStrict = (m: Metrics) => m.falseBlock.rate > study.max_false_block_rate;
  const verdict = (m: Metrics) => {
    if (m.checker === "none") return <Badge text="Baseline" />;
    if (m.checker === rec.withinLimits.pick) return <Badge text="Recommended" tone="ok" />;
    const why = [tooSlow(m) && "Too slow", tooStrict(m) && "Stops too many good sentences"].filter(Boolean).join(" · ");
    return why ? <span className="negative small">{why}</span> : <span className="muted small">Meets both limits</span>;
  };
  const point = (m: Metrics, x: number): Point => ({
    name: name(m.checker),
    kind: kindOf(specs.get(m.checker)!),
    x,
    y: m.caught.all.rate,
    details: [
      ["Wrong sentences stopped", `${rate(m.caught.all)} (${frac(m.caught.all)})`],
      ["Good sentences wrongly stopped", `${rate(m.falseBlock)} (${frac(m.falseBlock)})`],
      ["Extra silence before speaking (p95)", ms(m.firstAudio.p95)],
      ["Cost per 1,000 calls", usd(m.costPerCall * 1000)],
    ],
  });
  const contenders = shown.filter((m) => m.checker !== "none" && m.errors < m.caught.all.n);
  const byName = new Map(contenders.map((m) => [name(m.checker), m.checker]));
  const open = (label: string) => navigate(`/sentences/${id}?checker=${byName.get(label) ?? label}`);
  const aiJudges = rec.metrics.filter((m) => specs.get(m.checker)?.kind === "llm" && !isVariant(specs.get(m.checker)!));
  const range = (xs: number[], f: (x: number) => string) => (xs.length ? `${f(Math.min(...xs))}–${f(Math.max(...xs))}` : "n/a");
  const bad = pick?.caught.all;

  return (
    <div className="stack">
      <ReportContext report={report} />

      <section className="card answer-card" aria-label="Answer">
        <div className="card-body stack">
          <div>
            <div className="eyebrow">The question</div>
            <p className="lead">
              Can a voice agent check each sentence against its knowledge pack <em>before</em> the caller hears it, without making the call
              feel slow?
            </p>
          </div>
          <div>
            <div className="eyebrow">The answer{heldOutTitles.length ? `, on ${heldOutTitles.join(" and ")}` : ""}</div>
            {pick && bad ? (
              <p className="lead">
                <b>Yes.</b> The best setup, <b>{name(pick.checker)}</b>, stopped <b>{bad.k} of {bad.n}</b> wrong sentences ({rate(bad)}) and
                wrongly stopped <b>{pick.falseBlock.k} of {pick.falseBlock.n}</b> correct ones ({rate(pick.falseBlock)}). It adds{" "}
                <b>{ms(pick.firstAudio.p95)}</b> of silence before the agent speaks (budget {study.latency_budget_ms} ms) and costs{" "}
                <b>{usd(pick.costPerCall * 1000)}</b> per 1,000 calls.
              </p>
            ) : (
              <p className="lead">No setup stayed within both limits on this data.</p>
            )}
            {aiJudges.length > 0 && (
              <p className="ink-2">
                For comparison: AI judges that check <em>every</em> sentence stopped {range(aiJudges.map((m) => m.caught.all.rate), pct)} of
                wrong sentences but added {range(aiJudges.map((m) => m.firstAudio.p95), (x) => `${Math.round(x)}`)} ms of silence, too slow for
                a phone call. With no check at all, every wrong sentence is spoken.
              </p>
            )}
          </div>
          <details className="explain">
            <summary>How to read this page</summary>
            <ul>
              <li>
                <b>Wrong sentence:</b> something the agent says that its knowledge pack or the caller's account doesn't support: a wrong
                fee, an invented policy, a claim that something was done. Some are the agent's own mistakes; most are planted on purpose,
                because the agent rarely makes them.
              </li>
              <li>
                <b>Good sentences wrongly stopped:</b> correct sentences the check would have blocked. The caller hears a fallback line
                instead ("I'll have someone follow up"), so too many of these make the agent useless. Limit: {pct(study.max_false_block_rate)}.
              </li>
              <li>
                <b>Extra silence:</b> how much longer the caller waits before the agent's first word because of the check, for the slowest
                5% of turns (p95). Limit: {study.latency_budget_ms} ms.
              </li>
              <li>
                <b>The approaches:</b> <i>Rules only</i> is plain code: every price, time and date must appear in the knowledge pack.{" "}
                <i>Gemini Flash-Lite, GPT-5.4 nano, Claude Haiku</i> are small AI models asked "is this sentence supported?".{" "}
                <i>Jev</i> is a decision model that answers with one probability, which makes it fast. <i>Rules → model</i> runs the
                free rules first and only sends sentences with something to check (a price, a policy) to the AI model; greetings and
                questions are spoken immediately. Hover any name for a description.
              </li>
              {tuneTitles.length > 0 && (
                <li>
                  <b>Tuning vs. held out:</b> prompts were improved and cutoffs set using {tuneTitles.join(", ")} only. Everything above
                  the "Did tuning help?" section is measured on scenarios that weren't used for tuning, so it isn't flattered.
                </li>
              )}
              <li>
                <b>Answer key:</b> two AI models (not being tested) labeled each sentence; where they disagreed, the sentence is left out.
                These are AI labels, not human ones.
              </li>
            </ul>
          </details>
        </div>
      </section>

      <div className="charts">
        <section className="card">
          <div className="card-head">
            <h2>Accuracy vs. extra silence</h2>
            <span className="muted small">up and left is better</span>
          </div>
          <div className="card-body">
            <Scatter
              points={contenders.map((m) => point(m, m.firstAudio.p95)).filter((p) => p.x > 0)}
              xLabel="extra silence before speaking, p95 (ms)"
              formatX={(v) => `${v >= 1000 ? `${v / 1000}s` : `${v}`}`}
              limitX={{ value: study.latency_budget_ms, label: `${study.latency_budget_ms} ms budget` }}
              onSelect={open}
            />
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Accuracy vs. cost</h2>
            <span className="muted small">up and left is better</span>
          </div>
          <div className="card-body">
            <Scatter
              points={contenders.map((m) => point(m, m.costPerCall * 1000)).filter((p) => p.x > 0)}
              xLabel="$ per 1,000 calls"
              formatX={(v) => `$${v}`}
              onSelect={open}
            />
            <KindLegend />
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Every approach, side by side</h2>
          <div className="toolbar">
            <label className="check small">
              <input type="checkbox" checked={showVariants} onChange={(e) => setShowVariants(e.target.checked)} /> Show tuned variants
            </label>
            <label className="check small">
              <input type="checkbox" checked={showDetail} onChange={(e) => setShowDetail(e.target.checked)} /> More columns
            </label>
          </div>
        </div>
        <div className="card-body table-wrap">
          <table>
            <thead>
              <tr>
                <th>Approach</th>
                <th className="num">Wrong sentences stopped</th>
                <th className="num">Good sentences wrongly stopped</th>
                <th className="num">Extra silence (p95)</th>
                <th className="num">Cost / 1,000 calls</th>
                <th>Verdict</th>
                {showDetail && (
                  <>
                    <th className="num">Agent's own mistakes</th>
                    <th className="num">Planted: numbers</th>
                    <th className="num">Planted: meaning</th>
                    <th className="num">Silence p50</th>
                    <th className="num">Sentences sent to a model</th>
                    <th className="num">Checker errors</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const spec = specs.get(m.checker)!;
                return (
                  <tr key={m.checker} className="selectable" onClick={() => navigate(`/sentences/${id}?checker=${m.checker}`)} title={describe(spec)}>
                    <td>
                      <span className={`kind ${kindOf(spec)}`}>{name(m.checker)}</span>
                    </td>
                    <td className="num" title={ci(m.caught.all)}>
                      <b>{rate(m.caught.all)}</b> <span className="muted">{frac(m.caught.all)}</span>
                    </td>
                    <td className={`num ${tooStrict(m) ? "negative" : ""}`} title={ci(m.falseBlock)}>
                      {rate(m.falseBlock)} <span className="muted">{frac(m.falseBlock)}</span>
                    </td>
                    <td className={`num ${tooSlow(m) ? "negative" : ""}`}>{ms(m.firstAudio.p95)}</td>
                    <td className="num">{usd(m.costPerCall * 1000)}</td>
                    <td>{verdict(m)}</td>
                    {showDetail && (
                      <>
                        <td className="num">{rate(m.caught.natural)} <span className="muted">{frac(m.caught.natural)}</span></td>
                        <td className="num">{rate(m.caught.numeric)}</td>
                        <td className="num">{rate(m.caught.semantic)}</td>
                        <td className="num">{ms(m.firstAudio.p50)}</td>
                        <td className="num">{pct(m.modelShare)}</td>
                        <td className="num">{m.errors}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted small">Measured on {heldOutTitles.join(" and ")}. Click a row to see its sentences. Hover a rate for its 95% confidence interval.</p>
        </div>
      </section>

      {rec.tuneMetrics?.length > 0 && <TuningCard report={report} tuneTitles={tuneTitles} heldOutTitles={heldOutTitles} />}

      <CallerImpact metrics={shown} specs={specs} calls={calls} />

      <details className="card more">
        <summary>How the recommendation was picked (statistics)</summary>
        <div className="card-body stack">
          <PickRow role="Within limits" recommended pick={rec.withinLimits} specs={specs} />
          <PickRow role="Most accurate" pick={rec.mostAccurate} specs={specs} />
          <p className="muted">
            A fixed rule, no AI: among approaches within both limits, take the one that stops the most wrong sentences; any approach
            whose catches aren't statistically different from it (exact McNemar test, p ≥ 0.05) counts as tied, and the cheapest tied
            approach wins. With this many sentences, small differences are usually ties.
          </p>
        </div>
      </details>

      {results.packs.length > 1 && (
        <details className="card more">
          <summary>Results by scenario</summary>
          <div className="card-body table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Approach</th>
                  {results.packs.map((p) => (
                    <th key={p.id}>
                      {p.title}
                      {tunePacks.includes(p.id) ? " (tuning)" : ""}
                      <div className="muted small">stopped / wrongly stopped</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.checkers
                  .filter((c) => showVariants || !isVariant(c))
                  .map((c) => (
                    <tr key={c.name}>
                      <td>
                        <span className={`kind ${kindOf(c)}`}>{friendlyName(c)}</span>
                      </td>
                      {results.packs.map((p) => {
                        const st = packStats(results.items, results.verdicts, c.name, p.id);
                        return (
                          <td key={p.id} className="num">
                            {pct(st.caught)} / {pct(st.blocked)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <AuditCard report={report} />
    </div>
  );
}

function TuningCard({ report, tuneTitles, heldOutTitles }: { report: Report; tuneTitles: string[]; heldOutTitles: string[] }) {
  const rec = report.recommendation;
  const held = new Map(rec.metrics.map((m) => [m.checker, m]));
  const tuned = new Map(rec.tuneMetrics.map((m) => [m.checker, m]));
  const bases = report.results.checkers.filter((c) => c.kind !== "none" && c.kind !== "deterministic" && !isVariant(c));
  const cell = (m?: Metrics) => (m ? `${rate(m.caught.all)} / ${rate(m.falseBlock)}` : "—");
  return (
    <section className="card">
      <div className="card-head">
        <h2>Did tuning help?</h2>
        <span className="muted small">stopped / wrongly stopped</span>
      </div>
      <div className="card-body table-wrap">
        <p className="ink-2">
          Prompts were revised once (v2) and Jev's cutoff was tuned using {tuneTitles.join(", ")}. Gains there are flattering by design;
          the honest test is whether they hold on {heldOutTitles.join(" and ")}, which tuning never saw.
        </p>
        <table>
          <thead>
            <tr>
              <th>Approach</th>
              <th>Version</th>
              <th className="num">On {tuneTitles.join(", ")} (tuned on)</th>
              <th className="num">On {heldOutTitles.join(", ")} (held out)</th>
            </tr>
          </thead>
          <tbody>
            {bases.flatMap((b) => {
              const family = report.results.checkers.filter((c) => baseName(c.name) === b.name);
              return family.map((c, i) => (
                <tr key={c.name} className={i === 0 ? "group-start" : ""}>
                  <td>{i === 0 ? <span className={`kind ${kindOf(b)}`}>{friendlyName(b)}</span> : ""}</td>
                  <td className="muted">{isVariant(c) ? friendlyName(c).split(" · ").slice(1).join(" · ") : "original"}</td>
                  <td className="num">{cell(tuned.get(c.name))}</td>
                  <td className="num">{cell(held.get(c.name))}</td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function packStats(items: Item[], verdicts: VerdictRow[], checker: string, pack: string) {
  const blocked = new Set(verdicts.filter((v) => v.checker === checker && v.pack === pack && !v.pass).map((v) => v.id));
  const inPack = items.filter((i) => i.pack === pack);
  const bad = inPack.filter((i) => i.reference === "unsupported");
  const good = inPack.filter((i) => i.origin === "natural" && i.reference === "supported");
  return {
    caught: bad.length ? bad.filter((i) => blocked.has(i.id)).length / bad.length : NaN,
    blocked: good.length ? good.filter((i) => blocked.has(i.id)).length / good.length : NaN,
  };
}

function PickRow({ role, pick, specs, recommended }: { role: string; pick: Report["recommendation"]["withinLimits"]; specs: Map<string, CheckerSpec>; recommended?: boolean }) {
  return (
    <div className={`pick ${recommended ? "recommended" : ""}`}>
      <div className="role">{role}</div>
      <div>
        <div className="pick-head">
          {pick.pick ? <CheckerName spec={specs.get(pick.pick)} name={pick.pick} /> : <b>none</b>}
          {pick.leader && pick.leader !== pick.pick && <span className="muted">leader: {pick.leader}</span>}
        </div>
        {pick.tied.length > 1 && (
          <div className="muted small">
            Not significantly different from the leader:{" "}
            {pick.tied
              .filter((t) => t.checker !== pick.leader)
              .map((t) => `${t.checker} (p=${t.p.toFixed(2)})`)
              .join(", ")}
          </div>
        )}
      </div>
    </div>
  );
}

function CallerImpact({ metrics, specs, calls }: { metrics: Metrics[]; specs: Map<string, CheckerSpec>; calls: number }) {
  const per100 = (n: number) => (calls ? ((n / calls) * 100).toFixed(1) : "n/a");
  return (
    <section className="card">
      <div className="card-head">
        <h2>What callers would hear, per 100 calls (held out)</h2>
      </div>
      <div className="card-body table-wrap">
        <p className="muted">
          Two ways to use a check. <b>Wait for it</b>: each sentence is spoken only after it passes; a blocked one is swapped for "I'll
          have someone follow up". <b>Speak, then correct</b>: no waiting, but the caller hears every mistake first and the agent corrects
          the ones caught on its next turn. Counts the agent's own mistakes only, not planted ones.
        </p>
        <table>
          <thead>
            <tr>
              <th>Approach</th>
              <th className="num">Wait for it: wrong things the caller hears</th>
              <th className="num">Wait for it: needless "someone will follow up"</th>
              <th className="num">Speak, then correct: wrong things heard</th>
              <th className="num">…later corrected</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.checker}>
                <td>
                  <CheckerName spec={specs.get(m.checker)} name={m.checker} />
                </td>
                <td className="num">{per100(m.caught.natural.n - m.caught.natural.k)}</td>
                <td className="num">{per100(m.falseBlock.k)}</td>
                <td className="num">{per100(m.caught.natural.n)}</td>
                <td className="num">{per100(m.caught.natural.k)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const AUDIT_RULES: Record<string, string> = {
  "callback-promised-not-logged": "Callback promised, never logged",
  "card-number-in-transcript": "Card number read aloud",
  "amount-not-in-sources": "Dollar amount not in sources",
  "account-detail-before-verify": "Account detail before identity check",
};

function AuditCard({ report }: { report: Report }) {
  const rules = Object.keys(AUDIT_RULES);
  return (
    <section className="card">
      <div className="card-head">
        <h2>After-call audit</h2>
        <span className="muted">calls as simulated, without a gate</span>
      </div>
      <div className="card-body table-wrap">
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th className="num">Calls</th>
              {rules.map((r) => (
                <th className="num" key={r}>
                  {AUDIT_RULES[r]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.results.packs.map((p) => (
              <tr key={p.id}>
                <td>{p.title}</td>
                <td className="num">{p.calls}</td>
                {rules.map((r) => (
                  <td className={`num ${p.audit[r] ? "negative" : ""}`} key={r}>
                    {p.audit[r] ?? 0}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------- Calls */

/** How a verdict looks against the reference label. */
function outcome(item: Item | undefined, v: VerdictRow | undefined): { text: string; tone: string } {
  if (!item || !v) return { text: "not checked", tone: "neutral" };
  if (v.error) return { text: "checker error", tone: "err" };
  if (item.reference === "unsupported") return v.pass ? { text: "missed", tone: "bad" } : { text: "caught", tone: "ok" };
  if (item.reference === "supported") return v.pass ? { text: "spoken", tone: "neutral" } : { text: "wrongly blocked", tone: "bad" };
  return { text: v.pass ? "spoken (uncertain)" : "blocked (uncertain)", tone: "neutral" };
}

function usePackData(id: string, pack: string | undefined) {
  return useLoad<PackData>(pack ? `reports/${encodeURIComponent(id)}/data?pack=${encodeURIComponent(pack)}` : null);
}

function CheckerSelect({ checkers, value, onChange }: { checkers: CheckerSpec[]; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      Checker
      <select aria-label="Checker" value={value} onChange={(e) => onChange(e.target.value)}>
        {checkers.map((c) => (
          <option key={c.name} value={c.name}>
            {friendlyName(c)}
          </option>
        ))}
      </select>
    </label>
  );
}

function defaultChecker(report: Report): string {
  return report.recommendation.withinLimits.pick ?? report.results.checkers.find((c) => c.name !== "none")?.name ?? "none";
}

function Calls({ id, report, pack, callId }: { id: string; report: Report; pack?: string; callId?: string }) {
  const packs = report.results.packs;
  const activePack = pack ?? packs[0]?.id;
  const { data, error } = usePackData(id, activePack);
  const [checker, setChecker] = useState(defaultChecker(report));
  const items = useMemo(() => new Map(report.results.items.map((i) => [`${i.pack}|${i.id}`, i])), [report]);
  const verdicts = useMemo(
    () => new Map(report.results.verdicts.filter((v) => v.checker === checker).map((v) => [`${v.pack}|${v.id}`, v])),
    [report, checker],
  );
  const errorsIn = (call: CallRecord) =>
    report.results.items.filter((i) => i.pack === activePack && i.callId === call.callId && i.origin === "natural" && i.reference === "unsupported").length;
  const active = data?.calls.find((c) => c.callId === callId) ?? data?.calls[0];
  return (
    <div className="stack">
      <ReportContext report={report} />
      <div className="toolbar">
        {packs.length > 1 && (
          <div className="seg" role="group" aria-label="Scenario">
            {packs.map((p) => (
              <button key={p.id} className={p.id === activePack ? "on" : ""} aria-pressed={p.id === activePack} onClick={() => navigate(`/calls/${id}/${p.id}`)}>
                {p.title}
                {report.recommendation.tunePacks?.includes(p.id) ? " · tuning" : ""}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        <CheckerSelect checkers={report.results.checkers} value={checker} onChange={setChecker} />
      </div>
      <ErrorMessage text={error} />
      {!data && !error && <Loading what="calls" />}
      <div className="legend-bar small">
        <span className="ink-2">Each agent sentence is tagged with what the chosen check did:</span>
        <span className="cell neutral">spoken</span> correct, let through
        <span className="cell ok">caught</span> wrong, stopped
        <span className="cell bad">missed</span> wrong, but spoken
        <span className="cell bad">wrongly blocked</span> correct, but stopped
        <span className="ink-2">· Wavy underline = labeled wrong. Bars under a turn: <span className="tl-key check" /> checking{" "}
        <span className="tl-key wait" /> caller waits <span className="tl-key speech" /> agent speaking.</span>
      </div>
      {data && (
        <div className="calls-layout">
          <nav className="card call-list" aria-label="Calls">
            {data.calls.map((c) => {
              const n = errorsIn(c);
              return (
                <a
                  key={c.callId}
                  href={`#/calls/${id}/${activePack}/${encodeURIComponent(c.callId)}`}
                  className={c.callId === active?.callId ? "active" : ""}
                  aria-current={c.callId === active?.callId ? "true" : undefined}
                >
                  <span>{c.persona.replaceAll("-", " ")}</span>
                  <span className="muted small">#{c.callId.split(":").pop()}</span>
                  <span className="spacer" />
                  {n > 0 && <span className="cell bad" title="Natural unsupported sentences">{n}</span>}
                  {c.audit.length > 0 && <span className="cell err" title="Audit findings">{c.audit.length}</span>}
                </a>
              );
            })}
          </nav>
          {active && <Transcript call={active} data={data} items={items} verdicts={verdicts} report={report} />}
        </div>
      )}
    </div>
  );
}

function Transcript({
  call,
  data,
  items,
  verdicts,
  report,
}: {
  call: CallRecord;
  data: PackData;
  items: Map<string, Item>;
  verdicts: Map<string, VerdictRow>;
  report: Report;
}) {
  // Agent turns with text and sentence groups are recorded together, so they line up in order.
  const groups = useMemo(() => {
    const byTurn = new Map<number, typeof data.sentences>();
    for (const s of data.sentences.filter((s) => s.callId === call.callId)) {
      byTurn.set(s.turn, [...(byTurn.get(s.turn) ?? []), s]);
    }
    return [...byTurn.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g.sort((a, b) => a.position - b.position));
  }, [call, data]);
  const wps = report.results.study.speech_rate_wps;
  let agentTurn = -1;
  return (
    <section className="card transcript" aria-label="Transcript">
      <div className="card-head">
        <h2>{call.persona.replaceAll("-", " ")} caller</h2>
        <span className="muted">ended by {call.endedBy}</span>
      </div>
      <div className="card-body stack">
        {call.transcript.map((turn, i) => {
          if (turn.speaker === "caller") {
            return (
              <div className="turn caller" key={i}>
                <div className="who">Caller</div>
                <div className="bubble">{turn.text}</div>
              </div>
            );
          }
          agentTurn++;
          const group = agentTurn === 0 ? null : groups[agentTurn - 1];
          return (
            <div className="turn agent" key={i}>
              <div className="who">
                Agent <span className={`tag stage-${turn.stage}`}>{turn.stage === "active" ? "verified" : turn.stage}</span>
              </div>
              <div className="bubble">
                {group ? (
                  group.map((s) => {
                    const key = `${call.pack}|${s.id}`;
                    const item = items.get(key);
                    const v = verdicts.get(key);
                    const o = outcome(item, v);
                    return (
                      <span key={s.id} className={`sentence ref-${item?.reference ?? "none"} ${v && !v.pass ? "blocked" : ""}`}>
                        {s.sentence}{" "}
                        <span className={`cell ${o.tone}`} title={[item ? `label: ${item.reference}` : "", ...(v?.reasons ?? [])].filter(Boolean).join(" · ")}>
                          {o.text}
                          {v && v.latencyMs > 0 && <span className="p">{Math.round(v.latencyMs)} ms</span>}
                        </span>{" "}
                      </span>
                    );
                  })
                ) : (
                  <span className="muted-text">{turn.text}</span>
                )}
                {group && group.length > 0 && (
                  <TurnTimeline
                    checks={group.map((s) => verdicts.get(`${call.pack}|${s.id}`)?.latencyMs ?? 0)}
                    words={group.map((s) => s.sentence.split(/\s+/).length)}
                    blocked={group.map((s) => verdicts.get(`${call.pack}|${s.id}`)?.pass === false)}
                    wps={wps}
                  />
                )}
              </div>
            </div>
          );
        })}
        {(call.actions.length > 0 || call.audit.length > 0) && (
          <div className="call-facts">
            {call.actions.map((a, i) => (
              <div key={i}>
                <span className="tag">tool</span> {a.description}
              </div>
            ))}
            {call.audit.map((f, i) => (
              <div key={i}>
                <span className="cell err">audit</span> {AUDIT_RULES[f.rule] ?? f.rule}: {f.detail}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Hold-mode timing of one turn: every check starts when the text arrives (the LLM writes faster
 * than speech); a sentence plays once its check is done and the previous sentence has finished.
 */
function TurnTimeline({ checks, words, blocked, wps }: { checks: number[]; words: number[]; blocked: boolean[]; wps: number }) {
  let end = 0;
  const rows = checks.map((c, k) => {
    const start = Math.max(end, c);
    const dur = (words[k]! / wps) * 1000;
    end = start + dur;
    return { c, start, dur };
  });
  const total = Math.max(end, 1);
  const x = (t: number) => `${(t / total) * 100}%`;
  return (
    <div className="timeline" aria-label="Hold-mode timeline for this turn">
      {rows.map((r, k) => (
        <div className="tl-row" key={k}>
          <span className="tl-check" style={{ left: 0, width: x(r.c) }} title={`check ${Math.round(r.c)} ms`} />
          {r.start > (k === 0 ? 0 : rows[k - 1]!.start + rows[k - 1]!.dur) + 1 && (
            <span className="tl-wait" style={{ left: x(k === 0 ? 0 : rows[k - 1]!.start + rows[k - 1]!.dur), width: x(r.start - (k === 0 ? 0 : rows[k - 1]!.start + rows[k - 1]!.dur)) }} />
          )}
          <span className={`tl-speech ${blocked[k] ? "blocked" : ""}`} style={{ left: x(r.start), width: x(r.dur) }} title={blocked[k] ? "blocked: fallback line instead" : "spoken"} />
        </div>
      ))}
      <div className="tl-legend muted small">
        <span className="tl-key check" /> check <span className="tl-key wait" /> added silence <span className="tl-key speech" /> speech · first word at{" "}
        {Math.round(rows[0]?.start ?? 0)} ms
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Sentences */

function Sentences({ id, report }: { id: string; report: Report }) {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const { results } = report;
  const [origin, setOrigin] = useState("all");
  const [reference, setReference] = useState("unsupported");
  const [pack, setPack] = useState("all");
  const [disagree, setDisagree] = useState(false);
  const [query, setQuery] = useState("");
  const [focusChecker, setFocusChecker] = useState(params.get("checker") ?? "");
  const [selected, setSelected] = useState<Item>();
  const [showVariants, setShowVariants] = useState(false);
  const checkers = results.checkers.filter((c) => c.name !== "none" && (showVariants || !isVariant(c) || c.name === focusChecker));
  const verdicts = useMemo(() => {
    const m = new Map<string, Map<string, VerdictRow>>();
    for (const v of results.verdicts) {
      const key = `${v.pack}|${v.id}`;
      if (!m.has(key)) m.set(key, new Map());
      m.get(key)!.set(v.checker, v);
    }
    return m;
  }, [results]);
  const rows = results.items.filter((i) => {
    if (origin !== "all" && (origin === "planted" ? i.origin === "natural" : i.origin !== origin)) return false;
    if (reference !== "all" && i.reference !== reference) return false;
    if (pack !== "all" && i.pack !== pack) return false;
    if (query && !i.sentence.toLowerCase().includes(query.toLowerCase())) return false;
    if (disagree) {
      const vs = checkers.map((c) => verdicts.get(`${i.pack}|${i.id}`)?.get(c.name)?.pass);
      if (vs.every((v) => v === vs[0])) return false;
    }
    return true;
  });
  const shown = rows.slice(0, 300);
  return (
    <div className="stack">
      <ReportContext report={report} />
      <div className="toolbar">
        <label className="field">
          Origin
          <select value={origin} onChange={(e) => setOrigin(e.target.value)}>
            <option value="all">All</option>
            <option value="natural">The agent's own words</option>
            <option value="planted">Planted mistakes (any)</option>
            <option value="planted-numeric">Planted: a number changed</option>
            <option value="planted-semantic">Planted: meaning changed</option>
          </select>
        </label>
        <label className="field">
          Answer key says
          <select value={reference} onChange={(e) => setReference(e.target.value)}>
            <option value="all">Anything</option>
            <option value="unsupported">Wrong (should be stopped)</option>
            <option value="supported">Correct (should be spoken)</option>
            <option value="uncertain">Unsure (left out of scores)</option>
          </select>
        </label>
        {results.packs.length > 1 && (
          <label className="field">
            Scenario
            <select value={pack} onChange={(e) => setPack(e.target.value)}>
              <option value="all">All</option>
              {results.packs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Highlight
          <select value={focusChecker} onChange={(e) => setFocusChecker(e.target.value)}>
            <option value="">Nothing</option>
            {results.checkers
              .filter((c) => c.name !== "none")
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {friendlyName(c)}
                </option>
              ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={disagree} onChange={(e) => setDisagree(e.target.checked)} /> Approaches disagree
        </label>
        <label className="check">
          <input type="checkbox" checked={showVariants} onChange={(e) => setShowVariants(e.target.checked)} /> Show tuned variants
        </label>
        <input className="search" type="search" placeholder="Search sentences" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search sentences" />
        <span className="muted">
          {rows.length} sentence{rows.length === 1 ? "" : "s"}
          {rows.length > shown.length ? `, first ${shown.length} shown` : ""}
        </span>
      </div>
      <p className="legend-bar small">
        <span className="dot-outcome ok" /> got it right (stopped a wrong sentence) <span className="dot-outcome bad" /> got it wrong (spoke a
        wrong sentence, or stopped a correct one) <span className="dot-outcome neutral" /> correctly spoke a correct sentence. Click a row
        for details.
      </p>
      <section className="card">
        <div className="card-body table-wrap">
          <table className="sentence-table">
            <thead>
              <tr>
                <th>Sentence</th>
                <th>Label</th>
                {checkers.map((c) => (
                  <th key={c.name} className={`center col-name ${c.name === focusChecker ? "focus" : ""}`} title={describe(c)}>
                    <span className={`kind ${kindOf(c)}`}>{friendlyName(c)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <tr key={`${i.pack}|${i.id}`} className="selectable" onClick={() => setSelected(i)}>
                  <td className="state-cell">
                    {i.sentence}
                    <div className="muted small">
                      {i.origin === "natural" ? "natural" : i.origin.replace("planted-", "planted: ")} · {i.pack}
                    </div>
                  </td>
                  <td>
                    <Badge text={i.reference} tone={i.reference === "unsupported" ? "bad" : i.reference === "supported" ? "ok" : "neutral"} />
                  </td>
                  {checkers.map((c) => {
                    const o = outcome(i, verdicts.get(`${i.pack}|${i.id}`)?.get(c.name));
                    return (
                      <td key={c.name} className={`center ${c.name === focusChecker ? "focus" : ""}`}>
                        <span className={`dot-outcome ${o.tone}`} title={o.text} aria-label={`${c.name}: ${o.text}`} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty">No sentences match these filters.</div>}
        </div>
      </section>
      {selected && <SentenceDrawer id={id} item={selected} verdicts={verdicts.get(`${selected.pack}|${selected.id}`)} report={report} onClose={() => setSelected(undefined)} />}
    </div>
  );
}

function SentenceDrawer({ id, item, verdicts, report, onClose }: { id: string; item: Item; verdicts?: Map<string, VerdictRow>; report: Report; onClose: () => void }) {
  const { data } = usePackData(id, item.pack);
  const record = data && [...data.sentences, ...data.planted].find((s) => s.id === item.id);
  const parent = record?.parentId ? data?.sentences.find((s) => s.id === record.parentId) : undefined;
  const label = data?.labels.find((l) => l.id === item.id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Sentence details">
        <div className="card-head">
          <h2>Sentence</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="card-body stack">
          <blockquote className="quote">{item.sentence}</blockquote>
          <div className="toolbar">
            <Badge text={item.reference} tone={item.reference === "unsupported" ? "bad" : item.reference === "supported" ? "ok" : "neutral"} />
            <span className="muted">
              {item.origin} · {item.labelSource === "construction" ? "unsupported by construction" : `labeled by ${item.labelSource}`}
            </span>
          </div>
          {record?.change && (
            <Section title="What was planted">
              <p>{record.change}</p>
              {parent && <p className="muted">Original: “{parent.sentence}”</p>}
            </Section>
          )}
          {record && (
            <Section title="Context when spoken">
              <p className="muted">
                Stage: {record.stage} · caller facts {record.facts ? "available" : "not available"} · actions so far: {record.actions.length || "none"}
              </p>
              {record.previousCallerTurn && <p>Caller had said: “{record.previousCallerTurn}”</p>}
              <a href={`#/calls/${id}/${item.pack}/${encodeURIComponent(item.callId)}`}>Open the call →</a>
            </Section>
          )}
          {label && (
            <Section title="Labeler votes">
              {Object.entries(label.votes).map(([model, v]) => (
                <div key={model} className="vote">
                  <Badge text={v.supported ? "supported" : "unsupported"} tone={v.supported ? "ok" : "bad"} /> <span className="muted">{model}</span>
                  {v.unsupported_claims.length > 0 && <ul>{v.unsupported_claims.map((c, i) => <li key={i}>{c}</li>)}</ul>}
                </div>
              ))}
            </Section>
          )}
          <Section title="Checker verdicts">
            <table>
              <tbody>
                {report.results.checkers.map((c) => {
                  const v = verdicts?.get(c.name);
                  const o = outcome(item, v);
                  return (
                    <tr key={c.name}>
                      <td>
                        <CheckerName spec={c} name={c.name} />
                      </td>
                      <td>
                        <Badge text={o.text} tone={o.tone} />
                      </td>
                      <td className="num muted">{v ? ms(v.latencyMs) : ""}</td>
                      <td className="state-cell">{v?.error ?? v?.reasons.join("; ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Section>
        </div>
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="eyebrow">{title}</div>
      {children}
    </section>
  );
}

/* --------------------------------------------------------------- Playground */

interface CheckResult {
  verdicts: (VerdictRow & { kind: string; latencyMs: number; pSupported?: number })[];
  spendUsd: number;
}
interface GateResult {
  events: { type: "speak" | "blocked"; text: string; at: number }[];
  checks: { sentence: string; start: number; end: number; pass: boolean; reasons: string[]; cached: boolean }[];
  corrections: string[];
  speechRateWps: number;
  spendUsd: number;
}

const FREE = new Set(["none", "deterministic"]);

function Playground() {
  const { data: config, error } = useLoad<Config>("config");
  const [pack, setPack] = useState("");
  const [verified, setVerified] = useState(true);
  const [actions, setActions] = useState("");
  const [live, setLive] = useState(false);
  const [sentence, setSentence] = useState("");
  const [chosen, setChosen] = useState<string[]>(["deterministic"]);
  const [checkResult, setCheckResult] = useState<CheckResult>();
  const [turn, setTurn] = useState("");
  const [gateChecker, setGateChecker] = useState("deterministic");
  const [mode, setMode] = useState<"hold" | "speak-then-correct">("hold");
  const [gateResult, setGateResult] = useState<GateResult>();
  const [busy, setBusy] = useState("");
  const [requestError, setRequestError] = useState("");
  useEffect(() => {
    if (config && !pack) {
      const first = config.packs.find((p) => !p.private) ?? config.packs[0];
      if (first) {
        setPack(first.id);
        setExamples(first.id);
      }
    }
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  function setExamples(id: string) {
    const ex = config?.packs.find((p) => p.id === id)?.playground;
    setSentence(ex?.sentence ?? "");
    setTurn(ex?.turn ?? "");
  }
  if (error) return <ErrorMessage text={error} />;
  if (!config) return <Loading what="playground" />;
  const context = { pack, verified, actions: actions.split("\n").map((a) => a.trim()).filter(Boolean), live };
  async function post<T>(path: string, body: unknown, label: string, done: (r: T) => void) {
    setBusy(label);
    setRequestError("");
    try {
      done(await api<T>(path, { method: "POST", body: JSON.stringify(body) }));
    } catch (e) {
      setRequestError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  const paidChosen = chosen.some((c) => !FREE.has(config.checkers.find((s) => s.name === c)?.kind ?? ""));
  return (
    <div className="stack">
      <PageTitle title="Playground" description="Try the checkers and the streaming gate on your own sentences. Results here are not scored." />
      <section className="card">
        <div className="card-body toolbar">
          <label className="field">
            Scenario
            <select
              value={pack}
              onChange={(e) => {
                setPack(e.target.value);
                setExamples(e.target.value);
              }}
            >
              {config.packs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                  {p.private ? " (private)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /> Caller identity confirmed
          </label>
          <label className="field grow">
            Actions completed on this call (one per line)
            <textarea rows={1} value={actions} onChange={(e) => setActions(e.target.value)} placeholder="e.g. Callback requested from staff: billing question" />
          </label>
          <label className="check paid-control">
            <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} disabled={!config.hasKey} /> Allow paid model checks
            {!config.hasKey && <span className="muted"> (no OPENROUTER_API_KEY)</span>}
          </label>
        </div>
      </section>
      <ErrorMessage text={requestError} />
      <div className="playground-grid">
        <section className="card">
          <div className="card-head">
            <h2>Check one sentence</h2>
          </div>
          <div className="card-body stack">
            <label className="field">
              What the agent is about to say
              <textarea rows={3} value={sentence} onChange={(e) => setSentence(e.target.value)} />
            </label>
            <div className="checklist">
              {config.checkers
                .filter((c) => c.name !== "none")
                .map((c) => (
                  <label key={c.name} className="check">
                    <input
                      type="checkbox"
                      checked={chosen.includes(c.name)}
                      onChange={(e) => setChosen(e.target.checked ? [...chosen, c.name] : chosen.filter((x) => x !== c.name))}
                    />
                    <span className={`kind ${kindOf(c)}`} title={describe(c)}>{friendlyName(c)}</span>
                    {!FREE.has(c.kind) && <span className="muted small">paid</span>}
                  </label>
                ))}
            </div>
            <div className="toolbar">
              <button
                className="btn primary"
                disabled={!!busy || !sentence.trim() || !chosen.length || (paidChosen && !live)}
                onClick={() => post<CheckResult>("check", { ...context, sentence, checkers: chosen }, "check", setCheckResult)}
              >
                {busy === "check" ? "Checking…" : "Check"}
              </button>
              {paidChosen && !live && <span className="muted">Allow paid checks to use model checkers.</span>}
            </div>
            {checkResult && (
              <table>
                <tbody>
                  {checkResult.verdicts.map((v) => (
                    <tr key={v.checker}>
                      <td>
                        <CheckerName spec={config.checkers.find((c) => c.name === v.checker)} name={v.checker} />
                      </td>
                      <td>{v.error ? <Badge text="error" tone="err" /> : v.pass ? <Badge text="speak" tone="ok" /> : <Badge text="block" tone="bad" />}</td>
                      <td className="num muted">
                        {ms(v.latencyMs)}
                        {v.cached ? " (cached)" : ""}
                      </td>
                      <td className="state-cell">{v.error ?? v.reasons.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Stream a turn through the gate</h2>
          </div>
          <div className="card-body stack">
            <label className="field">
              The agent's whole reply, streamed word by word at fast-LLM speed
              <textarea rows={4} value={turn} onChange={(e) => setTurn(e.target.value)} />
            </label>
            <div className="toolbar">
              <CheckerSelect checkers={config.checkers.filter((c) => c.name !== "none")} value={gateChecker} onChange={setGateChecker} />
              <div className="seg" role="group" aria-label="Gate mode">
                {(["hold", "speak-then-correct"] as const).map((m) => (
                  <button key={m} className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => setMode(m)}>
                    {m === "hold" ? "Hold" : "Speak, then correct"}
                  </button>
                ))}
              </div>
              <button
                className="btn primary"
                disabled={!!busy || !turn.trim() || (!FREE.has(config.checkers.find((c) => c.name === gateChecker)?.kind ?? "") && !live)}
                onClick={() => post<GateResult>("gate", { ...context, text: turn, checker: gateChecker, mode }, "gate", setGateResult)}
              >
                {busy === "gate" ? "Streaming…" : "Run"}
              </button>
            </div>
            {gateResult && <GateView result={gateResult} mode={mode} />}
          </div>
        </section>
      </div>
    </div>
  );
}

function GateView({ result, mode }: { result: GateResult; mode: string }) {
  const firstSpoken = result.events.find((e) => e.type === "speak");
  return (
    <div className="stack">
      <div className="gate-events">
        {result.events.map((e, i) => (
          <div key={i} className={`gate-event ${e.type}`}>
            <span className="num muted">{Math.round(e.at)} ms</span>
            <span className={`cell ${e.type === "blocked" ? "bad" : "ok"}`}>{e.type === "blocked" ? "blocked" : "spoken"}</span>
            <span>{e.text}</span>
          </div>
        ))}
      </div>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Sentence check</th>
            <th className="num">Started</th>
            <th className="num">Done</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {result.checks.map((c, i) => (
            <tr key={i}>
              <td className="state-cell">{c.sentence}</td>
              <td className="num">{Math.round(c.start)} ms</td>
              <td className="num">{Math.round(c.end)} ms</td>
              <td>
                <Badge text={c.pass ? "pass" : "block"} tone={c.pass ? "ok" : "bad"} /> <span className="muted small">{c.reasons.join("; ")}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p className="muted">
        {mode === "hold"
          ? `First words ready to speak at ${Math.round(firstSpoken?.at ?? 0)} ms. Each check starts the moment its sentence is complete, so later checks run while earlier sentences are being spoken.`
          : result.corrections.length
            ? `Nothing waited. These were spoken and need a correction next turn: ${result.corrections.map((c) => `“${c}”`).join(" ")}`
            : "Nothing waited, and nothing needs correcting."}
        {result.spendUsd > 0 ? ` Spend: ${usd(result.spendUsd)}.` : ""}
      </p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

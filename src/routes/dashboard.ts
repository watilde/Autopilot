import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * The dashboard is the answer to "how would I know this is working?".
 *
 * It leads with outcomes — merged pull requests, merge rate, time to PR, cost
 * per merged PR — rather than activity, because activity is the metric that
 * lies. "Sessions started" can go up while nothing ships. Everything is fetched
 * from /api/analytics, so nothing shown here is computed twice.
 *
 * Three sections exist to keep the page honest rather than to make it look
 * good, and they are the ones worth defending:
 *
 *   - **Independent verification** puts what Devin claimed next to what the
 *     pull request's own CI found. A dashboard that only repeats the agent's
 *     self-report is the agent's press release.
 *   - **What the system refused to do** counts the work never paid for and the
 *     merge asked for but never observed. Those decisions produce no row
 *     anywhere else, so without this the most frequent thing the orchestrator
 *     does is invisible.
 *   - **Escalations** quotes the session verbatim. Summarising a refusal would
 *     be the dashboard inventing a reason.
 *
 * Charts follow the house data-viz rules: single-hue bars for magnitude,
 * reserved status colors for state (never reused as a series), no pie charts,
 * no dual axes, tabular figures in tables only, and a selected dark mode
 * rather than an inverted one.
 */
export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get('/', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    // replaceAll, not replace: __MODE__ appears twice — once as a class, once
    // as the badge's text — and replacing only the first left the literal
    // placeholder on screen next to a correctly coloured badge.
    return PAGE.replaceAll('__REPO__', `${config.GITHUB_OWNER}/${config.GITHUB_REPO}`).replaceAll(
      '__MODE__',
      config.DEVIN_MODE,
    );
  });
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autopilot — remediation control plane</title>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --baseline: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6;
    --series-1-soft: #cde2fb;
    --good: #0ca30c;
    --warning: #fab219;
    --serious: #ec835a;
    --critical: #d03b3b;
    --success-text: #006300;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --muted: #898781;
      --grid: #2c2c2a;
      --baseline: #383835;
      --border: rgba(255,255,255,0.10);
      --series-1: #3987e5;
      --series-1-soft: #184f95;
      --success-text: #0ca30c;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --grid: #2c2c2a;
    --baseline: #383835;
    --border: rgba(255,255,255,0.10);
    --series-1: #3987e5;
    --series-1-soft: #184f95;
    --success-text: #0ca30c;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--text-primary);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 64px; }

  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-bottom: 6px; }
  h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--text-secondary); font-size: 13px; margin: 0 0 24px; }
  .badge {
    font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
    padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border);
  }
  .badge.live { background: color-mix(in srgb, var(--good) 14%, transparent); color: var(--success-text); }
  .badge.mock { background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--text-secondary); }

  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em;
       color: var(--text-secondary); margin: 32px 0 12px; font-weight: 600; }

  .card { background: var(--surface-1); border: 1px solid var(--border);
          border-radius: 10px; padding: 16px 18px; }

  /* --- KPI row: hero numbers, no plot, so no legend and no hover layer --- */
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 12px; }
  .kpi .label { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
  .kpi .value { font-size: 30px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.1; }
  .kpi .note { font-size: 12px; color: var(--muted); margin-top: 4px; }

  /* --- state chips: status palette + label, never color alone --- */
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px;
          border: 1px solid var(--border); border-radius: 999px; background: var(--surface-1);
          font-size: 13px; }
  .chip .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
  .chip .n { font-weight: 650; font-variant-numeric: tabular-nums; }
  .dot.succeeded { background: var(--good); }
  .dot.failed { background: var(--critical); }
  .dot.timed_out { background: var(--serious); }
  .dot.blocked { background: var(--warning); }
  .dot.running, .dot.dispatching { background: var(--series-1); }

  /* --- bars: single hue, magnitude only, 4px rounded data-end --- */
  .bars { display: grid; gap: 10px; }
  .bar-row { display: grid; grid-template-columns: 140px 1fr 92px; align-items: center; gap: 12px; }
  .bar-label { font-size: 13px; color: var(--text-secondary); }
  .track { background: var(--grid); border-radius: 4px; height: 12px; position: relative; }
  .fill { background: var(--series-1); height: 100%; border-radius: 4px; min-width: 3px;
          transition: width .3s ease; }
  .bar-val { font-size: 12px; color: var(--text-secondary); text-align: right;
             font-variant-numeric: tabular-nums; }

  /* --- throughput: discrete days, column form --- */
  .spark { display: flex; align-items: flex-end; gap: 3px; height: 84px;
           border-bottom: 1px solid var(--baseline); padding-bottom: 0; }
  .spark .col { flex: 1; min-width: 8px; background: var(--series-1-soft); border-radius: 4px 4px 0 0;
                position: relative; cursor: default; }
  .spark .col .won { position: absolute; inset: auto 0 0 0; background: var(--series-1);
                     border-radius: 4px 4px 0 0; }
  .spark-x { display: flex; gap: 3px; margin-top: 6px; }
  .spark-x span { flex: 1; min-width: 8px; text-align: center; font-size: 10px; color: var(--muted);
                  overflow: hidden; white-space: nowrap; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 600; color: var(--text-secondary); font-size: 11px;
       text-transform: uppercase; letter-spacing: .04em; padding: 8px 10px;
       border-bottom: 1px solid var(--grid); }
  td { padding: 9px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
  td.num { font-variant-numeric: tabular-nums; }
  tbody tr:hover { background: color-mix(in srgb, var(--series-1) 5%, transparent); }
  a { color: var(--series-1); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .scroll { overflow-x: auto; }
  .empty { color: var(--muted); font-size: 13px; padding: 20px 0; text-align: center; }
  .foot { margin-top: 28px; font-size: 12px; color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }

  .lede { font-size: 13px; color: var(--muted); margin: 0 0 14px; max-width: 88ch; }
  .lede strong { color: var(--text-secondary); font-weight: 600; }

  /* --- verdict line: claimed vs independently checked ---------------------- */
  .verdict { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px 22px; }
  .verdict .n { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; }
  .verdict .k { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
  .verdict .why { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .verdict .n.ok { color: var(--success-text); }
  .verdict .n.warn { color: var(--serious); }

  /* --- escalations: the session's own words, never paraphrased ------------- */
  .esc { border-left: 3px solid var(--warning); padding: 2px 0 2px 14px; margin: 0 0 16px; }
  .esc:last-child { margin-bottom: 0; }
  .esc .head { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
  .esc blockquote {
    margin: 0; font-size: 13px; line-height: 1.55; color: var(--text-primary);
    white-space: pre-wrap; font-family: inherit;
  }
  .esc code { background: color-mix(in srgb, var(--muted) 16%, transparent);
              border-radius: 3px; padding: 1px 4px; }

  /* --- evidence drawer: Devin's verification output, verbatim -------------- */
  tbody tr.head-row { cursor: pointer; }
  tbody tr.head-row td:first-child::before {
    content: "▸"; color: var(--muted); font-size: 10px; margin-right: 6px;
  }
  tbody tr.head-row.open td:first-child::before { content: "▾"; }
  tr.evidence > td { background: color-mix(in srgb, var(--series-1) 4%, transparent);
                     padding: 14px 16px 16px; }
  .ev-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; margin-bottom: 10px; }
  .ev-k { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .ev-v { font-size: 13px; line-height: 1.5; }
  pre.out {
    margin: 0; padding: 10px 12px; border-radius: 6px; overflow-x: auto;
    background: color-mix(in srgb, var(--text-primary) 6%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; line-height: 1.5; color: var(--text-secondary);
  }
  .ev-note { font-size: 12px; color: var(--muted); margin: 8px 0 0; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Autopilot</h1>
    <span class="badge __MODE__" id="mode">__MODE__</span>
    <span class="badge" id="repo">__REPO__</span>
  </header>
  <p class="sub">
    Event-driven issue remediation. GitHub issues in, verified Devin pull requests out.
    <span id="stamp"></span>
  </p>

  <h2>Outcomes</h2>
  <div class="kpis" id="kpis"></div>

  <h2>Independent verification</h2>
  <div class="card">
    <p class="lede">
      Devin runs the contract's <code>verify</code> block in its sandbox and reports the result.
      A job on the pull request reads <strong>the same block off the same issue</strong> and runs
      it again. One definition of done, checked by two parties — one of which has no stake in
      the answer.
    </p>
    <div class="verdict" id="verify"></div>
  </div>

  <h2>What the system refused to do</h2>
  <div class="card">
    <p class="lede">
      Decisions that produce no pull request and no row anywhere else. A system that reports
      only what it did is not observable.
    </p>
    <div class="verdict" id="refusals"></div>
  </div>

  <h2>Escalated to a human</h2>
  <div class="card" id="escalations"></div>

  <h2>Pipeline</h2>
  <div class="card"><div class="chips" id="chips"></div></div>

  <h2>By category</h2>
  <div class="card"><div class="bars" id="cats"></div></div>

  <h2>What started the work</h2>
  <div class="card"><div class="bars" id="triggers"></div></div>

  <h2 id="tp-h">Throughput — completed per day</h2>
  <div class="card" id="tp-card">
    <div class="spark" id="spark"></div>
    <div class="spark-x" id="sparkx"></div>
    <p class="bar-val" style="text-align:left;margin:10px 0 0;color:var(--muted)">
      Solid = succeeded, pale = other terminal outcomes.
    </p>
  </div>

  <h2>Remediations</h2>
  <div class="card scroll">
    <p class="lede">
      Click a row for the evidence: what Devin changed, what it ran, and what those commands
      printed — its own words, not this dashboard's summary of them.
    </p>
    <p class="lede" id="tbl-filter"></p>
    <table id="table">
    <thead><tr>
      <th>Issue</th><th>Contract</th><th>State</th><th>Cycle</th>
      <th>Session</th><th>Pull request</th><th>CI</th>
    </tr></thead>
    <tbody></tbody>
  </table></div>

  <h2>As reported by Devin</h2>
  <div class="card scroll">
    <p class="bar-val" style="text-align:left;margin:0 0 10px;color:var(--muted)">
      Pulled from Devin's own session analytics — the independent view of the same work.
      Tags are what the orchestrator actually sent.
    </p>
    <table id="devin">
      <thead><tr>
        <th>Session</th><th>Status</th><th>Tags</th><th class="num">ACU</th><th>Pull request</th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <h2 id="fails-h">Why things failed</h2>
  <div class="card" id="fails-card"><div class="bars" id="fails"></div></div>

  <p class="foot">
    Auto-refreshes every 5s · <a href="/api/analytics">/api/analytics</a> ·
    <a href="/metrics">/metrics</a> · <a href="/healthz">/healthz</a>
  </p>
</div>

<script>
const pct = v => v === null || v === undefined ? "—" : (v * 100).toFixed(0) + "%";
const dur = s => {
  if (s === null || s === undefined) return "—";
  if (s < 90) return Math.round(s) + "s";
  if (s < 5400) return (s / 60).toFixed(1) + "m";
  return (s / 3600).toFixed(1) + "h";
};
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** Cut on a word boundary — a title severed mid-word reads as a rendering bug. */
const trim = (s, n) => {
  s = String(s ?? "");
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut) + "…";
};

/** Whether withdrawn rows are folded away. Survives the refresh; see the table. */
let showWithdrawn = false;

function kpi(label, value, note) {
  return '<div class="card kpi"><div class="label">' + label + '</div>' +
         '<div class="value">' + value + '</div>' +
         '<div class="note">' + (note || "&nbsp;") + '</div></div>';
}

/** A figure inside a card, with the sentence that says why it is the honest one. */
function vd(value, label, why, tone) {
  return '<div><div class="n ' + (tone || "") + '">' + value + '</div>' +
         '<div class="k">' + label + '</div>' +
         '<div class="why">' + why + '</div></div>';
}

/**
 * Devin's structured report, if it sent one. Held here rather than merged into
 * the row so that what the agent said stays visibly separate from what we
 * observed — the whole page depends on not blurring those two.
 */
function claim(r) {
  const s = r.structuredOutput;
  return s && typeof s === "object" ? s : null;
}

async function refresh() {
  let a, rs;
  try {
    [a, rs] = await Promise.all([
      fetch("/api/analytics").then(r => r.json()),
      fetch("/api/remediations?limit=40").then(r => r.json()),
    ]);
  } catch { return; }

  const t = a.totals;

  // Outcome-shaped KPIs. Success rate is over *completed* work so that
  // in-flight items cannot inflate it, and the two latencies stay apart: one
  // is the agent's, the other is ours.
  document.getElementById("kpis").innerHTML = [
    kpi("Merged", t.prsMerged,
        t.prsOpened + " opened" + (t.prsClosed ? ", " + t.prsClosed + " closed unmerged" : "")),
    kpi("Merge rate", pct(a.mergeRate), "of opened PRs accepted"),
    kpi("Success rate", pct(a.successRate),
        t.concluded + " concluded · " + t.cancelled + " withdrawn, excluded"),
    kpi("Issue → PR", dur(a.timeToPrSeconds.p50),
        "median · p90 " + dur(a.timeToPrSeconds.p90) + " · agent latency"),
    kpi("PR → merged", dur(a.timeToMergeSeconds.p50),
        "median · human review, reported separately"),
    kpi("ACU per merged PR", a.acu.perMergedPr ? a.acu.perMergedPr.toFixed(1) : "—",
        a.acu.reported
          ? a.acu.total.toFixed(1) + " ACU total"
          : "provider reported none — not the same as free"),
  ].join("");

  // The claim, and the independent check of the claim, side by side.
  //
  // The promoted count is the direction that costs something to build. Demoting a
  // "fixed" that does not build is easy and everyone does it; recording a
  // success the agent itself declined to claim requires trusting the evidence
  // over the report, and it is the case where this system disagrees with Devin
  // in Devin's favour.
  const withPr = rs.remediations.filter(r => r.prUrl).length;
  const claimed = rs.remediations.filter(r => claim(r) && claim(r).verification_passed === true).length;
  const promoted = rs.remediations.filter(r => {
    const c = claim(r);
    return c && c.verification_passed === false && r.ciStatus === "passed";
  }).length;

  document.getElementById("verify").innerHTML = [
    vd(claimed + " / " + withPr, "Claimed passing",
       "sessions reporting verification_passed, of those that opened a PR", ""),
    vd(a.ci.passed, "Confirmed by CI", "the same commands, re-run on the pull request",
       a.ci.passed ? "ok" : ""),
    vd(promoted, "Promoted over the report",
       "Devin reported it blocked; CI passed on the same pull request, so the record says succeeded",
       promoted ? "ok" : ""),
    vd(a.ci.reworks, "Self-corrections", "red runs handed back and fixed with no human", ""),
    vd(a.ci.failed, "Currently red", "pull requests whose latest run disagrees",
       a.ci.failed ? "warn" : ""),
    vd(t.falsePositives, "Success with no PR", "reported fixed with nothing to show for it",
       t.falsePositives ? "warn" : ""),
  ].join("");

  document.getElementById("refusals").innerHTML = [
    vd(a.refusals.deduplicated, "Intake refusals",
       "already in flight, already fixed, already merged — never dispatched, never paid for", ""),
    vd(t.cancelled, "Withdrawn", "cancelled before a verdict: a decision, not a loss", ""),
    vd(a.refusals.mergeRequested, "Merges requested", "asking is not merging", ""),
    vd(a.refusals.mergeEscalated, "Merges escalated",
       "requested, never observed, handed to a human",
       a.refusals.mergeEscalated ? "warn" : ""),
  ].join("");

  // Triggers: where the work came from. Intake does not care, which is the
  // point — a scanner or a webhook is the same door.
  const tgmax = Math.max(1, ...a.triggers.map(x => x.count));
  document.getElementById("triggers").innerHTML = a.triggers.length
    ? a.triggers.map(x =>
        '<div class="bar-row"><div class="bar-label">' + esc(x.trigger) + '</div>' +
        '<div class="track"><div class="fill" style="width:' + ((x.count / tgmax) * 100) + '%"></div></div>' +
        '<div class="bar-val">' + x.count + '</div></div>').join("")
    : '<div class="empty">Nothing triggered yet.</div>';

  document.getElementById("chips").innerHTML = a.byState.length
    ? a.byState.map(s =>
        '<span class="chip"><span class="dot ' + esc(s.state) + '"></span>' +
        esc(s.state) + ' <span class="n">' + s.count + '</span></span>').join("")
    : '<span class="empty">No remediations yet.</span>';

  // Throughput columns. Hidden below two days: a single bar is a number
  // wearing a chart's clothes, and it crowds out the sections that argue.
  const tp = a.throughput;
  const showTp = tp.length > 1 ? "" : "none";
  document.getElementById("tp-h").style.display = showTp;
  document.getElementById("tp-card").style.display = showTp;
  const max = Math.max(1, ...tp.map(d => d.completed));
  document.getElementById("spark").innerHTML = tp.length
    ? tp.map(d => {
        const h = (d.completed / max) * 100;
        const w = d.completed ? (d.succeeded / d.completed) * 100 : 0;
        return '<div class="col" style="height:' + Math.max(h, 3) + '%" title="' +
               esc(d.day) + ': ' + d.completed + ' completed, ' + d.succeeded + ' succeeded">' +
               '<div class="won" style="height:' + w + '%"></div></div>';
      }).join("")
    : '<div class="empty" style="margin:auto">No completed work yet.</div>';
  document.getElementById("sparkx").innerHTML = tp.map(d => '<span>' + d.day.slice(5) + '</span>').join("");

  // Category bars — single hue, magnitude only
  const cmax = Math.max(1, ...a.byCategory.map(c => c.total));
  document.getElementById("cats").innerHTML = a.byCategory.length
    ? a.byCategory.map(c =>
        '<div class="bar-row"><div class="bar-label">' + esc(c.category) + '</div>' +
        '<div class="track" title="' + esc(c.category) + ': ' + c.total + ' total, ' +
        c.prsOpened + ' PRs"><div class="fill" style="width:' +
        ((c.total / cmax) * 100) + '%"></div></div>' +
        '<div class="bar-val">' + c.prsOpened + ' PR / ' + c.total + '</div></div>').join("")
    : '<div class="empty">Nothing categorised yet.</div>';

  // Nothing failed is not a chart. The section disappears rather than
  // congratulating itself with an empty card.
  const showFails = a.failureReasons.length ? "" : "none";
  document.getElementById("fails-h").style.display = showFails;
  document.getElementById("fails-card").style.display = showFails;
  document.getElementById("fails").innerHTML = a.failureReasons.length
    ? (() => {
        const fmax = Math.max(1, ...a.failureReasons.map(f => f.count));
        return a.failureReasons.map(f =>
          '<div class="bar-row"><div class="bar-label" title="' + esc(f.reason) + '">' +
          esc(f.reason.slice(0, 34)) + '</div><div class="track"><div class="fill" style="width:' +
          ((f.count / fmax) * 100) + '%"></div></div>' +
          '<div class="bar-val">' + f.count + '</div></div>').join("");
      })()
    : '<div class="empty">No failures recorded. 🎉</div>';

  // Withdrawals are folded away by default and counted in the open: twelve
  // near-identical intake refusals are the system working, but they crowd out
  // the five rows a reader came to look at. Hidden, never dropped — the count
  // is on screen and one click brings them back.
  const shown = showWithdrawn
    ? rs.remediations
    : rs.remediations.filter(r => r.state !== "cancelled");
  const folded = rs.remediations.length - shown.length;
  document.getElementById("tbl-filter").innerHTML = folded || showWithdrawn
    ? (showWithdrawn
        ? 'Showing all ' + rs.remediations.length + ' rows, withdrawals included. ' +
          '<a href="#" id="tbl-toggle">Hide withdrawn</a>'
        : folded + ' withdrawn ' + (folded === 1 ? "row is" : "rows are") +
          ' folded away — cancelled before a verdict, excluded from the success rate. ' +
          '<a href="#" id="tbl-toggle">Show them</a>')
    : "";

  const rows = shown.map((r, i) => {
    const secs = r.completedAt
      ? (new Date(r.completedAt) - new Date(r.createdAt)) / 1000
      : (Date.now() - new Date(r.createdAt)) / 1000;
    return '<tr class="head-row" data-i="' + i + '">' +
      '<td><a href="' + esc(r.issueUrl) + '" target="_blank" rel="noopener">#' + r.issueNumber +
        '</a><br><span style="color:var(--muted)">' + esc(trim(r.title, 64)) + '</span></td>' +
      '<td><code>' + esc(r.contractId || "—") + '</code></td>' +
      '<td><span class="chip"><span class="dot ' + esc(r.state) + '"></span>' + esc(r.state) + '</span></td>' +
      '<td class="num">' + dur(secs) + '</td>' +
      '<td>' + (r.devinSessionUrl
        ? '<a href="' + esc(r.devinSessionUrl) + '" target="_blank" rel="noopener">session</a>' : "—") + '</td>' +
      '<td>' + (r.prUrl
        ? '<a href="' + esc(r.prUrl) + '" target="_blank" rel="noopener">#' +
          esc(r.prUrl.split("/").pop()) + '</a> ' +
          '<span style="color:var(--muted)">' + esc(r.prState || "open") + '</span>'
        : "—") + '</td>' +
      '<td>' + (r.ciStatus
        ? (r.ciStatus === "passed" ? "✅" : r.ciStatus === "failed" ? "❌" : "…") + " " + esc(r.ciStatus) +
          (r.reworks ? ' <span style="color:var(--muted)">' + r.reworks + '× fixed</span>' : "")
        : "—") + '</td>' +
    '</tr>' + evidenceRow(r, i);
  }).join("");
  document.querySelector("#table tbody").innerHTML =
    rows || '<tr><td colspan="7" class="empty">Nothing dispatched yet. Label an issue to begin.</td></tr>';

  document.getElementById("stamp").textContent =
    "· updated " + new Date(a.generatedAt).toLocaleTimeString();

  restoreOpenRows();
  await Promise.all([refreshDevin(), refreshEscalations()]);
}

/**
 * The evidence, quoted rather than summarised.
 *
 * verification_output is what the contract's own commands printed in Devin's
 * sandbox. Rendering it verbatim is the point: a dashboard that condensed it to
 * a green tick would be asserting the very thing the reader came to check.
 */
function evidenceRow(r, i) {
  const c = claim(r);
  if (!c) return "";

  const files = Array.isArray(c.files_changed) ? c.files_changed : [];
  const out = typeof c.verification_output === "string" ? c.verification_output : "";

  return '<tr class="evidence" data-ev="' + i + '" hidden><td colspan="7">' +
    '<div class="ev-grid">' +
      '<div><div class="ev-k">Devin&rsquo;s summary</div><div class="ev-v">' +
        esc(c.summary || "—") + '</div></div>' +
      '<div><div class="ev-k">Files changed · confidence</div><div class="ev-v">' +
        (files.length ? files.map(f => '<code>' + esc(f) + '</code>').join(" ") : "none") +
        ' · ' + esc(c.confidence || "—") + '</div></div>' +
    '</div>' +
    (out
      ? '<div class="ev-k" style="margin-bottom:5px">Verification output — the contract&rsquo;s own commands</div>' +
        '<pre class="out">' + esc(out) + '</pre>'
      : '<p class="ev-note">This session reported no verification output.</p>') +
    '<p class="ev-note">Reported by the agent. ' +
      (r.ciStatus === "passed"
        ? 'CI re-ran the same block on the pull request and agreed.'
        : r.ciStatus === "failed"
          ? 'CI re-ran the same block and <strong>disagreed</strong> — see the run on the pull request.'
          : 'CI has not returned a verdict on this one.') +
    '</p>' +
  '</td></tr>';
}

/**
 * Which drawers are open survives the 5s refresh. Losing an expanded row
 * mid-sentence because a poll landed is the kind of thing that makes people
 * stop reading.
 */
const openRows = new Set();

function restoreOpenRows() {
  document.querySelectorAll("#table tbody tr.head-row").forEach(tr => {
    const i = tr.dataset.i;
    const ev = document.querySelector('#table tbody tr.evidence[data-ev="' + i + '"]');
    if (!ev) return;
    const open = openRows.has(Number(i));
    ev.hidden = !open;
    tr.classList.toggle("open", open);
  });
}

document.querySelector("#table tbody").addEventListener("click", e => {
  if (e.target.closest("a")) return;
  const tr = e.target.closest("tr.head-row");
  if (!tr) return;
  const i = Number(tr.dataset.i);
  if (openRows.has(i)) openRows.delete(i);
  else openRows.add(i);
  restoreOpenRows();
});

document.getElementById("tbl-filter").addEventListener("click", e => {
  if (!e.target.closest("#tbl-toggle")) return;
  e.preventDefault();
  showWithdrawn = !showWithdrawn;
  // Row indices shift with the filter, so an open drawer would reopen against
  // a different remediation.
  openRows.clear();
  refresh();
});

/**
 * Escalations, in the session's own words.
 *
 * Autopilot asks for a merge and never records one — the merge is read back
 * from GitHub like any other observer. When the merge does not happen, the
 * reason belongs on screen unedited: keyword-matching a refusal to produce a
 * tidier label would be the system inventing a cause.
 */
async function refreshEscalations() {
  const el = document.getElementById("escalations");
  let events = [];
  try {
    const body = await fetch("/api/events?type=merge.escalated&limit=5").then(r => r.json());
    events = body.events || [];
  } catch { return; }

  if (!events.length) {
    el.innerHTML = '<div class="empty">Nothing escalated. Every requested merge was observed.</div>';
    return;
  }

  el.innerHTML =
    '<p class="lede">Autopilot asks for a merge. It never records one — the merge is read back ' +
    'from GitHub like any other observer. When it does not happen, the issue is labelled ' +
    '<code>autopilot:needs-human</code> and the session is quoted <strong>verbatim</strong>.</p>' +
    events.map(e => {
      const d = e.detail || {};
      return '<div class="esc"><div class="head">' +
        'issue #' + esc(e.issueNumber) + ' · ' +
        (d.prUrl
          ? '<a href="' + esc(d.prUrl) + '" target="_blank" rel="noopener">' +
            'pull request #' + esc(String(d.prUrl).split("/").pop()) + '</a>'
          : 'no pull request') +
        ' · requested ' + esc(d.requestedAt ? new Date(d.requestedAt).toLocaleString() : "—") +
        ' · escalated ' + esc(new Date(e.createdAt).toLocaleString()) +
        '</div><blockquote>' + esc(d.reason || "no reason recorded") + '</blockquote></div>';
    }).join("");
}

/**
 * Devin's own view. Kept in its own request and its own try/catch: it crosses a
 * network boundary we do not control, and a provider hiccup must not blank the
 * numbers we already computed locally.
 */
async function refreshDevin() {
  const tbody = document.querySelector("#devin tbody");
  let sessions = [];
  let note = "";
  try {
    const res = await fetch("/api/devin/insights");
    const body = await res.json();
    sessions = body.sessions || [];
    if (body.error) note = body.error;
  } catch (e) {
    note = "could not reach the Devin API";
  }

  if (!sessions.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">' +
      esc(note || "No sessions reported yet.") + '</td></tr>';
    return;
  }

  tbody.innerHTML = sessions.map(s => {
    const pr = s.pullRequests && s.pullRequests[0];
    const detail = s.statusDetail ? s.status + "/" + s.statusDetail : s.status;
    return '<tr>' +
      '<td>' + (s.url
        ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title || s.sessionId) + '</a>'
        : esc(s.title || s.sessionId)) + '</td>' +
      '<td>' + esc(detail) + '</td>' +
      '<td><code>' + esc((s.tags || []).join(" ")) + '</code></td>' +
      '<td class="num">' + (s.acusConsumed === null ? "—" : s.acusConsumed) + '</td>' +
      '<td>' + (pr
        ? '<a href="' + esc(pr.url) + '" target="_blank" rel="noopener">#' +
          esc(pr.url.split("/").pop()) + '</a> <span style="color:var(--muted)">' +
          esc(pr.state) + '</span>'
        : "—") + '</td>' +
    '</tr>';
  }).join("");
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

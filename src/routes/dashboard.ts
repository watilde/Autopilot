import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/**
 * The dashboard is the answer to "how would I know this is working?".
 *
 * It leads with outcomes (pull requests opened, success rate over completed
 * work, median and p90 cycle time, cost per PR) rather than activity, because
 * activity is the metric that lies. Everything is fetched from /api/analytics,
 * so nothing shown here is computed twice.
 *
 * Charts follow the house data-viz rules: single-hue bars for magnitude,
 * reserved status colors for state (never reused as a series), no pie charts,
 * no dual axes, tabular figures in tables only, and a selected dark mode
 * rather than an inverted one.
 */
export function registerDashboardRoutes(app: FastifyInstance): void {
  app.get('/', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return PAGE.replace('__REPO__', `${config.GITHUB_OWNER}/${config.GITHUB_REPO}`).replace(
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

  <h2>Pipeline</h2>
  <div class="card"><div class="chips" id="chips"></div></div>

  <h2>Throughput — completed per day</h2>
  <div class="card">
    <div class="spark" id="spark"></div>
    <div class="spark-x" id="sparkx"></div>
    <p class="bar-val" style="text-align:left;margin:10px 0 0;color:var(--muted)">
      Solid = succeeded, pale = other terminal outcomes.
    </p>
  </div>

  <h2>By category</h2>
  <div class="card"><div class="bars" id="cats"></div></div>

  <h2>Remediations</h2>
  <div class="card scroll"><table id="table">
    <thead><tr>
      <th>Issue</th><th>Contract</th><th>State</th><th>Cycle</th>
      <th>Session</th><th>Pull request</th>
    </tr></thead>
    <tbody></tbody>
  </table></div>

  <h2>Why things failed</h2>
  <div class="card"><div class="bars" id="fails"></div></div>

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

function kpi(label, value, note) {
  return '<div class="card kpi"><div class="label">' + label + '</div>' +
         '<div class="value">' + value + '</div>' +
         '<div class="note">' + (note || "&nbsp;") + '</div></div>';
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
  // in-flight items cannot inflate it.
  document.getElementById("kpis").innerHTML = [
    kpi("Pull requests opened", t.prsOpened, "merge-ready output"),
    kpi("Success rate", pct(a.successRate), t.completed + " completed"),
    kpi("Median cycle time", dur(a.cycleTimeSeconds.p50), "p90 " + dur(a.cycleTimeSeconds.p90)),
    kpi("In flight", t.active, "cap " + (t.active > 0 ? "engaged" : "idle")),
    kpi("ACU per PR", a.acu.perPr ? a.acu.perPr.toFixed(1) : "—", a.acu.total.toFixed(1) + " total"),
    kpi("False positives", t.falsePositives, "reports correctly rejected"),
  ].join("");

  document.getElementById("chips").innerHTML = a.byState.length
    ? a.byState.map(s =>
        '<span class="chip"><span class="dot ' + esc(s.state) + '"></span>' +
        esc(s.state) + ' <span class="n">' + s.count + '</span></span>').join("")
    : '<span class="empty">No remediations yet.</span>';

  // Throughput columns
  const tp = a.throughput;
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

  const rows = rs.remediations.map(r => {
    const secs = r.completedAt
      ? (new Date(r.completedAt) - new Date(r.createdAt)) / 1000
      : (Date.now() - new Date(r.createdAt)) / 1000;
    return '<tr>' +
      '<td><a href="' + esc(r.issueUrl) + '" target="_blank" rel="noopener">#' + r.issueNumber +
        '</a><br><span style="color:var(--muted)">' + esc((r.title || "").slice(0, 46)) + '</span></td>' +
      '<td><code>' + esc(r.contractId || "—") + '</code></td>' +
      '<td><span class="chip"><span class="dot ' + esc(r.state) + '"></span>' + esc(r.state) + '</span></td>' +
      '<td class="num">' + dur(secs) + '</td>' +
      '<td>' + (r.devinSessionUrl
        ? '<a href="' + esc(r.devinSessionUrl) + '" target="_blank" rel="noopener">session</a>' : "—") + '</td>' +
      '<td>' + (r.prUrl
        ? '<a href="' + esc(r.prUrl) + '" target="_blank" rel="noopener">' +
          esc(r.prUrl.split("/").pop()) + '</a>' : "—") + '</td>' +
    '</tr>';
  }).join("");
  document.querySelector("#table tbody").innerHTML =
    rows || '<tr><td colspan="6" class="empty">Nothing dispatched yet. Label an issue to begin.</td></tr>';

  document.getElementById("stamp").textContent =
    "· updated " + new Date(a.generatedAt).toLocaleTimeString();
}

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

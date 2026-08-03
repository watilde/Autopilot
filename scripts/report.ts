import { config } from '../src/config.js';
import { Store } from '../src/db/index.js';
import { buildAnalytics } from '../src/obs/analytics.js';

/**
 * Terminal report, read straight from the SQLite event log.
 *
 * Deliberately does not go through the HTTP API: this has to work when the
 * service is down, which is exactly when someone wants to know what happened.
 * Same numbers as the dashboard, same source.
 *
 *   npm run report            human-readable
 *   npm run report -- --json  machine-readable, for CI summaries
 */

const asJson = process.argv.includes('--json');

const store = new Store(config.DATABASE_PATH);
const a = buildAnalytics(store);

if (asJson) {
  console.log(JSON.stringify(a, null, 2));
  process.exit(0);
}

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);
const dur = (s: number | null) =>
  s === null ? '—' : s < 90 ? `${Math.round(s)}s` : `${(s / 60).toFixed(1)}m`;
const bar = (v: number, max: number, width = 24) =>
  '█'.repeat(Math.max(v > 0 ? 1 : 0, Math.round((v / Math.max(max, 1)) * width)));

const t = a.totals;

console.log(`\n  AUTOPILOT REPORT — ${config.GITHUB_OWNER}/${config.GITHUB_REPO}`);
console.log(`  generated ${a.generatedAt}   mode ${config.DEVIN_MODE}`);
console.log(`  ${'─'.repeat(62)}`);

console.log('\n  OUTCOMES');
console.log(`    pull requests merged .... ${t.prsMerged}  (of ${t.prsOpened} opened)`);
console.log(`    merge rate .............. ${pct(a.mergeRate)}`);
console.log(`    success rate ............ ${pct(a.successRate)}  (of ${t.concluded} concluded)`);
console.log(`    false positives ......... ${t.falsePositives}  (reports correctly rejected)`);
console.log(`    failed .................. ${t.failed}`);
console.log(`    timed out ............... ${t.timedOut}`);
console.log(`    withdrawn ............... ${t.cancelled}  (cancelled; excluded from success rate)`);
console.log(`    in flight ............... ${t.active}`);

console.log('\n  LATENCY');
console.log(`    issue → PR (median) ..... ${dur(a.timeToPrSeconds.p50)}   p90 ${dur(a.timeToPrSeconds.p90)}`);
console.log(`    PR → merged (median) .... ${dur(a.timeToMergeSeconds.p50)}   human review`);
console.log(`    full cycle (median) ..... ${dur(a.cycleTimeSeconds.p50)}   p90 ${dur(a.cycleTimeSeconds.p90)}`);

console.log('\n  INDEPENDENT VERIFICATION');
console.log(`    CI passed ............... ${a.ci.passed}`);
console.log(`    CI failed ............... ${a.ci.failed}`);
console.log(`    self-corrections ........ ${a.ci.reworks}  (CI failures fixed by Devin, no human)`);

console.log('\n  COST');
if (a.acu.reported) {
  console.log(`    ACUs consumed ........... ${a.acu.total.toFixed(1)}`);
  console.log(`    ACUs per merged PR ...... ${a.acu.perMergedPr ? a.acu.perMergedPr.toFixed(1) : '—'}`);
} else {
  // "Not measured" and "free" are different claims, and only one of them is true.
  console.log(`    ACUs .................... not reported by the provider for this account`);
}

if (a.byCategory.length) {
  console.log('\n  BY CATEGORY');
  const max = Math.max(...a.byCategory.map((c) => c.total));
  for (const c of a.byCategory) {
    console.log(
      `    ${c.category.padEnd(14)} ${bar(c.total, max).padEnd(24)} ` +
        `${String(c.total).padStart(3)} total, ${c.prsOpened} PR, ${pct(c.successRate)} success`,
    );
  }
}

if (a.throughput.length) {
  console.log('\n  THROUGHPUT');
  const max = Math.max(...a.throughput.map((d) => d.completed));
  for (const d of a.throughput) {
    console.log(
      `    ${d.day}  ${bar(d.completed, max).padEnd(24)} ${d.completed} completed, ${d.succeeded} succeeded`,
    );
  }
}

if (a.failureReasons.length) {
  console.log('\n  WHY THINGS FAILED');
  for (const f of a.failureReasons) {
    console.log(`    ${String(f.count).padStart(3)} × ${f.reason.slice(0, 56)}`);
  }
}

if (a.triggers.length) {
  console.log('\n  TRIGGERED BY');
  for (const tr of a.triggers) console.log(`    ${String(tr.count).padStart(3)} × ${tr.trigger}`);
}

console.log('');
store.close();

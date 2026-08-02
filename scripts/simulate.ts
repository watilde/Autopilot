import { signPayload } from '../src/github/webhook.js';
import type { AnalyticsSnapshot } from '../src/obs/analytics.js';
import { SEED_ISSUES } from './issues.js';

/**
 * End-to-end demo driver.
 *
 * Fires real, correctly-signed GitHub webhook payloads at a running Autopilot
 * and then watches the analytics endpoint until everything reaches a terminal
 * state. Nothing is stubbed inside the server: the signature is verified, the
 * contract is parsed, sessions are created and reconciled, metrics move. Only
 * the two external systems — GitHub and Devin — are standing in.
 *
 *   npm run simulate                    all seeded issues
 *   npm run simulate -- --only SEC-001  a single contract
 *   npm run simulate -- --duplicate     also replay a delivery, to show dedup
 */

const BASE = process.env.AUTOPILOT_URL ?? 'http://localhost:8080';
const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;
const withDuplicate = process.argv.includes('--duplicate');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const getAnalytics = (): Promise<AnalyticsSnapshot> =>
  fetch(`${BASE}/api/analytics`).then((r) => r.json() as Promise<AnalyticsSnapshot>);

function payloadFor(issue: (typeof SEED_ISSUES)[number], number: number) {
  return {
    action: 'labeled',
    label: { name: 'autopilot' },
    issue: {
      number,
      title: issue.title,
      body: issue.body,
      html_url: `https://github.com/watilde/superset/issues/${number}`,
      state: 'open',
      labels: issue.labels.map((name) => ({ name })),
    },
    repository: { full_name: 'watilde/superset' },
  };
}

async function deliver(body: unknown, deliveryId: string): Promise<unknown> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': 'issues',
    'x-github-delivery': deliveryId,
  };
  // Only sign when a secret is configured; otherwise the server is running in
  // ALLOW_UNSIGNED_WEBHOOKS mode for a local demo.
  if (SECRET) headers['x-hub-signature-256'] = signPayload(raw, SECRET);

  const res = await fetch(`${BASE}/webhooks/github`, { method: 'POST', headers, body: raw });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main(): Promise<void> {
  const health = (await fetch(`${BASE}/healthz`)
    .then((r) => r.json())
    .catch(() => null)) as { mode: string; repo: string } | null;
  if (!health) {
    console.error(`\nNo Autopilot at ${BASE}. Start it first:\n  npm run dev\n`);
    process.exit(1);
  }

  console.log(`\nAutopilot simulation → ${BASE}`);
  console.log(`  mode: ${health.mode}   repo: ${health.repo}   signed: ${SECRET ? 'yes' : 'no'}\n`);

  const issues = only ? SEED_ISSUES.filter((i) => i.key === only) : SEED_ISSUES;
  if (!issues.length) {
    console.error(`No seeded issue matches "${only}".`);
    process.exit(1);
  }

  console.log('Delivering webhooks:');
  for (const [i, issue] of issues.entries()) {
    const number = 9000 + i;
    const result = (await deliver(payloadFor(issue, number), `sim-${issue.key}-${number}`)) as {
      status: number;
      body: { accepted?: boolean; reason?: string };
    };
    console.log(
      `  ${issue.key.padEnd(9)} issue #${number}  →  ${result.status} ` +
        `${result.body.accepted ? 'accepted' : `skipped (${result.body.reason ?? '?'})`}`,
    );
  }

  if (withDuplicate) {
    const first = issues[0]!;
    const replay = (await deliver(payloadFor(first, 9000), `sim-${first.key}-9000`)) as {
      body: { deduplicated?: boolean };
    };
    console.log(
      `\n  replayed the first delivery id → ${replay.body.deduplicated ? 'deduplicated ✓' : 'NOT deduplicated ✗'}`,
    );
  }

  console.log('\nWaiting for sessions to reach a terminal state');
  for (let i = 0; i < 60; i++) {
    await fetch(`${BASE}/api/tick`, { method: 'POST' }).catch(() => {});
    const a = await getAnalytics();
    process.stdout.write(
      `\r  active ${String(a.totals.active).padStart(2)}  ` +
        `completed ${String(a.totals.completed).padStart(2)}  ` +
        `PRs ${String(a.totals.prsOpened).padStart(2)}   `,
    );
    if (a.totals.active === 0 && a.totals.completed > 0) break;
    await sleep(1000);
  }

  const a = await getAnalytics();
  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(0)}%`);

  console.log('\n\nResult');
  console.log(`  completed .......... ${a.totals.completed}`);
  console.log(`  succeeded .......... ${a.totals.succeeded}`);
  console.log(`  failed ............. ${a.totals.failed}`);
  console.log(`  pull requests ...... ${a.totals.prsOpened}`);
  console.log(`  success rate ....... ${pct(a.successRate)}`);
  console.log(`  median cycle ....... ${a.cycleTimeSeconds.p50?.toFixed(1) ?? '—'}s`);
  console.log(`\nDashboard: ${BASE}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

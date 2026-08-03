/**
 * Ask Autopilot to go and find something to fix.
 *
 * The step before every other one. Autopilot's usual trigger is an issue that
 * already exists; this starts a session that reads the repository, decides what
 * is worth fixing, and files contract-carrying issues. Those come back through
 * the ordinary webhook path and are refused at intake like anything else if the
 * contract is not valid — so the audit cannot bypass a single gate downstream.
 *
 *   npm run audit          start one and wait for it
 *   npm run audit -- --now start one and exit
 */

const BASE = process.env.AUTOPILOT_URL ?? 'http://localhost:8080';
const detach = process.argv.includes('--now');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AuditReply {
  dispatched: boolean;
  reason: string;
  sessionId?: string;
  url?: string;
}

async function main(): Promise<void> {
  const health = (await fetch(`${BASE}/healthz`)
    .then((r) => r.json())
    .catch(() => null)) as { mode: string; repo: string } | null;
  if (!health) {
    console.error(`\nNo Autopilot at ${BASE}. Start it first:\n  npm run dev\n`);
    process.exit(1);
  }

  console.log(`\nAudit → ${health.repo}   mode: ${health.mode}`);

  const res = await fetch(`${BASE}/api/audit`, { method: 'POST' });
  const body = (await res.json()) as AuditReply;

  if (!body.dispatched) {
    console.error(`\n✗ Not dispatched: ${body.reason}`);
    if (body.url) console.error(`  The one already running: ${body.url}`);
    console.error('');
    process.exit(1);
  }

  console.log(`  session  ${body.sessionId}`);
  console.log(`  ${body.url}`);

  if (detach) {
    console.log(`\nRunning. Watch it at ${BASE}, or check /api/audit.\n`);
    return;
  }

  console.log('\nWaiting for it to finish. Issues it files arrive as webhooks meanwhile.');
  for (let i = 0; i < 240; i++) {
    await fetch(`${BASE}/api/tick`, { method: 'POST' }).catch(() => {});
    const status = (await fetch(`${BASE}/api/audit`).then((r) => r.json())) as {
      inFlight: Array<{ sessionId: string }>;
    };
    if (!status.inFlight.some((a) => a.sessionId === body.sessionId)) break;
    process.stdout.write(`\r  … running (${i * 5}s)   `);
    await sleep(5000);
  }

  const events = (await fetch(`${BASE}/api/events?type=audit.finished&limit=5`).then((r) =>
    r.json(),
  )) as { events: Array<{ detail: { sessionId?: string; filed?: number; output?: unknown } }> };
  const mine = events.events.find((e) => e.detail?.sessionId === body.sessionId);

  console.log('\n');
  if (!mine) {
    console.log('Still running. Nothing was lost — check /api/audit later.\n');
    return;
  }

  const filed = mine.detail.filed ?? 0;
  console.log(`Filed ${filed} issue(s).`);
  if (filed === 0) {
    console.log('An audit that finds nothing worth filing is a legitimate result, not a failure.');
  }
  console.log(`\nDashboard: ${BASE}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

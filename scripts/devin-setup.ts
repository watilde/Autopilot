import { config } from '../src/config.js';
import { createDevinClient } from '../src/devin/index.js';
import { supportsPlatformApi } from '../src/devin/types.js';
import { REMEDIATION_PLAYBOOK, auditPrompt } from '../src/core/prompt.js';

/**
 * Provision the two Devin-side objects this system relies on.
 *
 *   playbook  the standing procedure every remediation session runs under
 *   schedule  a recurring audit that files new, already-dispatchable issues
 *
 * Split out of the server on purpose. These are account-level resources with
 * their own lifecycle: creating them on every boot would either duplicate them
 * or require reconciliation logic for something a human sets up once. So this
 * is idempotent by name, prints what it did, and exits.
 *
 *   npm run devin:setup           create anything missing
 *   npm run devin:setup -- --show list what already exists
 *
 * The schedule closes the loop at the front. Everything else in Autopilot
 * starts from "a human noticed and labelled an issue"; the audit is what keeps
 * the backlog from depending on someone remembering to look.
 */

const showOnly = process.argv.includes('--show');
// Monday 09:00 UTC: a week's worth of drift, reviewed at the start of the week.
const AUDIT_CRON = process.env.AUDIT_CRON ?? '0 9 * * 1';
const AUDIT_NAME = `Autopilot audit — ${config.GITHUB_OWNER}/${config.GITHUB_REPO}`;

const devin = createDevinClient();

if (!supportsPlatformApi(devin)) {
  console.error(
    `Playbooks and schedules need the v3 API; this client is ${devin.apiVersion} in ${devin.mode} mode.\n` +
      'Set DEVIN_MODE=live with a cog_ service-user key and DEVIN_ORG_ID.',
  );
  process.exit(1);
}

const schedules = await devin.listSchedules();
console.log(`\n  schedules  ${schedules.length}`);
for (const s of schedules) {
  console.log(`    ${s.scheduleId}  ${s.frequency ?? 'one-off'}  ${s.enabled ? 'enabled' : 'disabled'}  ${s.name}`);
}

if (showOnly) {
  const insights = await devin.listSessionInsights(10);
  console.log(`\n  recent sessions  ${insights.length}`);
  for (const s of insights) {
    const pr = s.pullRequests[0]?.url ?? '—';
    console.log(
      `    ${s.status.padEnd(8)} acu ${String(s.acusConsumed ?? '—').padStart(5)}  ${s.title ?? s.sessionId}\n` +
        `             tags ${s.tags.join(', ') || '—'}\n` +
        `             pr   ${pr}`,
    );
  }
  process.exit(0);
}

// --- playbook ---------------------------------------------------------------

if (config.DEVIN_PLAYBOOK_ID) {
  console.log(`\n  playbook   already configured: ${config.DEVIN_PLAYBOOK_ID}`);
} else {
  const playbook = await devin.createPlaybook({
    title: REMEDIATION_PLAYBOOK.title,
    body: REMEDIATION_PLAYBOOK.body,
  });
  console.log(`\n  playbook   created: ${playbook.playbookId}  (${playbook.title})`);
  console.log(`\n    Add this to .env so dispatched sessions run under it:`);
  console.log(`      DEVIN_PLAYBOOK_ID=${playbook.playbookId}`);
}

// --- scheduled audit --------------------------------------------------------

const existing = schedules.find((s) => s.name === AUDIT_NAME);
if (existing) {
  console.log(`\n  schedule   already exists: ${existing.scheduleId}  (${existing.frequency})`);
} else {
  const created = await devin.createSchedule({
    name: AUDIT_NAME,
    prompt: auditPrompt(config.GITHUB_OWNER, config.GITHUB_REPO, config.AUTOPILOT_LABEL),
    frequency: AUDIT_CRON,
    playbookId: config.DEVIN_PLAYBOOK_ID,
    tags: ['autopilot', 'audit', `repo:${config.GITHUB_OWNER}/${config.GITHUB_REPO}`],
  });
  console.log(`\n  schedule   created: ${created.scheduleId}  (${created.frequency})`);
  console.log(
    `\n    Devin will audit ${config.GITHUB_OWNER}/${config.GITHUB_REPO} on this cadence and file\n` +
      `    contract-carrying issues labelled "${config.AUTOPILOT_LABEL}". Those arrive back here\n` +
      `    as webhooks, so the backlog refills without anyone remembering to look.`,
  );
}

console.log('');

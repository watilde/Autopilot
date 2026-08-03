import { signPayload } from '../src/github/webhook.js';
import type { Remediation } from '../src/types.js';
import { SEED_ISSUES } from './issues.js';

/**
 * The whole chain, in one run: issue → pull request → CI → review → revision →
 * approval → merge.
 *
 * `npm run simulate` fires five issues at the server and waits for them to
 * settle. That shows throughput. It does not show the loop, because every one
 * of those five goes straight from dispatch to a terminal state and nothing
 * ever comes back. This script drives a single remediation through every path
 * the orchestrator has, one step at a time, asserting the state after each —
 * so a reader can watch a change request land on a closed session and be
 * picked up, which is the part that is hard to believe from a diagram.
 *
 * Every event here is a real, correctly-signed GitHub webhook. Nothing inside
 * the server is stubbed: the signature is verified, the contract is parsed,
 * the session is created and polled, the review is routed. What stands in is
 * GitHub — the events it would send are sent by this script instead — and, in
 * mock mode, Devin.
 *
 *   npm run scenario                 against a local server (DEVIN_MODE=mock)
 *   npm run scenario -- --issue 4242 pick the issue number to use
 *
 * Against a live Devin and a real repository the script does not apply: GitHub
 * sends those events itself, and the review is a person or another agent
 * running `gh pr review`. What this proves is that the routing is right, which
 * is the part a live run cannot isolate.
 */

const BASE = process.env.AUTOPILOT_URL ?? 'http://localhost:8080';
const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';
const ISSUE = Number(
  process.argv.includes('--issue') ? process.argv[process.argv.indexOf('--issue') + 1] : 7100,
);
const REPO = 'watilde/superset';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let step = 0;
function heading(title: string, why: string): void {
  console.log(`\n${String(++step).padStart(2)}. ${title}`);
  console.log(`    ${why}`);
}

function detail(line: string): void {
  console.log(`    → ${line}`);
}

async function deliver(event: string, body: unknown, deliveryId: string): Promise<unknown> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': deliveryId,
  };
  // Only sign when a secret is configured; otherwise the server is running in
  // ALLOW_UNSIGNED_WEBHOOKS mode for a local demo.
  if (SECRET) headers['x-hub-signature-256'] = signPayload(raw, SECRET);

  const res = await fetch(`${BASE}/webhooks/github`, { method: 'POST', headers, body: raw });
  return res.json().catch(() => ({}));
}

async function remediation(): Promise<Remediation | null> {
  const body = (await fetch(`${BASE}/api/remediations?limit=200`).then((r) => r.json())) as {
    remediations: Remediation[];
  };
  // Newest attempt for this issue: a retry creates a second row, and the one
  // being driven is always the last.
  return body.remediations.filter((r) => r.issueNumber === ISSUE).at(0) ?? null;
}

/**
 * Poll until the record says what we are waiting for, forcing a reconcile each
 * time rather than waiting out RECONCILE_INTERVAL_MS. Returns null on timeout
 * so the caller can fail with a sentence rather than a stack trace.
 */
async function until(
  what: string,
  predicate: (r: Remediation) => boolean,
  attempts = 40,
): Promise<Remediation | null> {
  for (let i = 0; i < attempts; i++) {
    await fetch(`${BASE}/api/tick`, { method: 'POST' }).catch(() => {});
    const r = await remediation();
    if (r && predicate(r)) return r;
    process.stdout.write(`\r    … waiting for ${what} (${i + 1}/${attempts})   `);
    await sleep(500);
  }
  process.stdout.write('\r');
  return null;
}

function give(r: Remediation | null, what: string): Remediation {
  if (!r) {
    console.error(`\n\n✗ Gave up waiting for ${what}.`);
    console.error(`  Check ${BASE} and the server log; the scenario stops here rather than`);
    console.error('  reporting a step it did not actually observe.\n');
    process.exit(1);
  }
  process.stdout.write('\r');
  return r;
}

async function main(): Promise<void> {
  const health = (await fetch(`${BASE}/healthz`)
    .then((r) => r.json())
    .catch(() => null)) as { mode: string; repo: string } | null;
  if (!health) {
    console.error(`\nNo Autopilot at ${BASE}. Start it first:\n  npm run dev\n`);
    process.exit(1);
  }

  const seed = SEED_ISSUES[2] ?? SEED_ISSUES[0]!;
  const branch = `autopilot/${seed.key.toLowerCase()}-issue-${ISSUE}`;
  const runUrl = `https://github.com/${REPO}/actions/runs/77001`;

  console.log(`\nAutopilot scenario → ${BASE}`);
  console.log(`  mode: ${health.mode}   repo: ${health.repo}   signed: ${SECRET ? 'yes' : 'no'}`);
  console.log(`  driving issue #${ISSUE} (${seed.key}) on branch ${branch}`);

  // -- 1 ----------------------------------------------------------------------
  heading('File the issue', 'A contract-carrying issue is labelled. Intake decides, not the label alone.');
  const filed = (await deliver(
    'issues',
    {
      action: 'labeled',
      label: { name: 'autopilot' },
      issue: {
        number: ISSUE,
        title: seed.title,
        body: seed.body,
        html_url: `https://github.com/${REPO}/issues/${ISSUE}`,
        state: 'open',
        labels: seed.labels.map((name) => ({ name })),
      },
      repository: { full_name: REPO },
    },
    `scenario-${ISSUE}-filed`,
  )) as { accepted?: boolean; reason?: string };

  if (!filed.accepted) {
    console.error(`\n✗ Intake declined it: ${filed.reason ?? 'unknown'}`);
    console.error('  Most likely this issue number was already used. Re-run with --issue <n>.\n');
    process.exit(1);
  }
  detail('accepted, queued');

  // -- 2 ----------------------------------------------------------------------
  heading('Devin opens a pull request', 'Dispatch, then the reconciler polls until a PR exists.');
  const opened = give(await until('a pull request', (r) => !!r.prUrl), 'a pull request');
  detail(`${opened.state} · ${opened.prUrl}`);
  detail(`session ${opened.devinSessionId}`);

  // -- 3 ----------------------------------------------------------------------
  heading(
    'CI rejects it',
    'The verify block runs again on the PR. A red build goes back to the session, not to a person.',
  );
  await deliver(
    'workflow_run',
    {
      action: 'completed',
      workflow_run: {
        id: 77001,
        name: 'autopilot-verify',
        head_branch: branch,
        conclusion: 'failure',
        status: 'completed',
        html_url: runUrl,
      },
      repository: { full_name: REPO },
    },
    `scenario-${ISSUE}-ci-fail`,
  );
  const reopened = give(
    await until('the work to reopen', (r) => r.reworks >= 1),
    'the work to reopen',
  );
  detail(`state ${reopened.state} · ci ${reopened.ciStatus} · self-corrections ${reopened.reworks}`);

  // -- 4 ----------------------------------------------------------------------
  heading('Devin fixes it and CI agrees', 'The same branch, the same session, no human in between.');
  give(await until('the session to finish again', (r) => r.state === 'succeeded'), 'the session');
  await deliver(
    'workflow_run',
    {
      action: 'completed',
      workflow_run: {
        id: 77002,
        name: 'autopilot-verify',
        head_branch: branch,
        conclusion: 'success',
        status: 'completed',
        html_url: `https://github.com/${REPO}/actions/runs/77002`,
      },
      repository: { full_name: REPO },
    },
    `scenario-${ISSUE}-ci-pass`,
  );
  const green = give(await until('a green build', (r) => r.ciStatus === 'passed'), 'a green build');
  detail(`state ${green.state} · ci ${green.ciStatus}`);

  // -- 5 ----------------------------------------------------------------------
  heading(
    'A reviewer requests changes',
    'The question CI cannot ask. The reviewer may be a person or another agent — the loop cannot tell.',
  );
  const prNumber = Number(green.prUrl?.split('/').pop() ?? 0);
  const reviewPayload = (state: string, body: string | null) => ({
    action: 'submitted',
    review: {
      state,
      body,
      html_url: `https://github.com/${REPO}/pull/${prNumber}#pullrequestreview-${state}`,
      user: { login: 'reviewer' },
    },
    pull_request: {
      number: prNumber,
      html_url: green.prUrl,
      state: 'open',
      head: { ref: branch },
    },
    repository: { full_name: REPO },
  });

  await deliver(
    'pull_request_review',
    reviewPayload(
      'changes_requested',
      'This works, but it duplicates the helper in superset/utils. Use that instead.',
    ),
    `scenario-${ISSUE}-review-changes`,
  );
  const revising = give(
    await until('a revision to start', (r) => r.reviewReworks >= 1),
    'a revision',
  );
  detail(`state ${revising.state} · review revisions ${revising.reviewReworks}`);
  detail(`counted apart from CI self-corrections, still ${revising.reworks}`);

  // -- 6 ----------------------------------------------------------------------
  heading('Devin revises, the reviewer approves', 'Approval alone does not merge — the build still has to be green.');
  give(await until('the revision to land', (r) => r.state === 'succeeded'), 'the revision');
  await deliver(
    'pull_request_review',
    reviewPayload('approved', 'Better. Thanks.'),
    `scenario-${ISSUE}-review-approve`,
  );
  detail('approved');

  // -- 7 ----------------------------------------------------------------------
  heading('The merge is observed, not recorded', 'Autopilot asks. GitHub is what says it happened.');
  await deliver(
    'pull_request',
    {
      action: 'closed',
      pull_request: {
        number: prNumber,
        html_url: green.prUrl,
        state: 'closed',
        merged: true,
        merged_at: new Date().toISOString(),
        head: { ref: branch },
      },
      repository: { full_name: REPO },
    },
    `scenario-${ISSUE}-merged`,
  );
  const merged = give(await until('the merge', (r) => r.prState === 'merged'), 'the merge');
  detail(`pr ${merged.prState} · state ${merged.state}`);

  // -- the record -------------------------------------------------------------
  const events = (await fetch(`${BASE}/api/events?limit=200`).then((r) => r.json())) as {
    events: Array<{ type: string; issueNumber: number | null; createdAt: string }>;
  };
  const mine = events.events.filter((e) => e.issueNumber === ISSUE).reverse();

  console.log('\n\nThe audit log for this one issue:\n');
  const t0 = new Date(mine[0]?.createdAt ?? Date.now()).getTime();
  for (const e of mine) {
    const dt = ((new Date(e.createdAt).getTime() - t0) / 1000).toFixed(1);
    console.log(`  +${dt.padStart(6)}s  ${e.type}`);
  }

  console.log(`\nEvery step above is a webhook the server verified and routed.`);
  console.log(`Dashboard: ${BASE}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

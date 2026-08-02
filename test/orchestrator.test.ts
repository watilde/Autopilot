import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/index.js';
import { DevinMockClient } from '../src/devin/mock.js';
import { GitHubClient, type IssueRef } from '../src/github/client.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { SEED_ISSUES } from '../scripts/issues.js';

function issue(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    number: 101,
    title: 'Unsafe YAML deserialization',
    body: SEED_ISSUES[0]!.body,
    htmlUrl: 'https://github.com/watilde/superset/issues/101',
    state: 'open',
    labels: ['autopilot', 'security'],
    ...overrides,
  };
}

function harness(mock?: DevinMockClient) {
  const store = new Store(':memory:');
  const devin = mock ?? new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'fixed' });
  // No token → GitHub is inert, which is exactly the demo/offline path.
  const github = new GitHubClient(undefined, 'watilde', 'superset');
  return { store, devin, orchestrator: new Orchestrator(store, devin, github) };
}

describe('intake', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('accepts a labelled issue carrying a valid contract', async () => {
    const r = await h.orchestrator.intake(issue(), 'test');
    expect(r.accepted).toBe(true);
    expect(r.remediation?.state).toBe('queued');
    expect(r.remediation?.contractId).toBe('SEC-001');
    expect(r.remediation?.category).toBe('security');
  });

  it('skips an issue without the autopilot label', async () => {
    const r = await h.orchestrator.intake(issue({ labels: ['security'] }), 'test');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/not labelled/);
  });

  it('skips a closed issue', async () => {
    const r = await h.orchestrator.intake(issue({ state: 'closed' }), 'test');
    expect(r.accepted).toBe(false);
  });

  it('rejects a labelled issue with no contract', async () => {
    const r = await h.orchestrator.intake(issue({ body: 'please just fix it' }), 'test');
    expect(r.accepted).toBe(false);
    expect(r.reason).toMatch(/contract block/);
  });

  // The expensive mistake this system could make is paying for the same fix
  // twice, so deduplication gets its own tests.
  it('deduplicates an issue that is already in flight', async () => {
    const first = await h.orchestrator.intake(issue(), 'webhook');
    expect(first.accepted).toBe(true);

    const second = await h.orchestrator.intake(issue(), 'scheduled-scan');
    expect(second.accepted).toBe(false);
    expect(second.reason).toMatch(/already in flight/);
    expect(h.store.listAll()).toHaveLength(1);
  });

  it('allows a fresh attempt once the previous one is terminal', async () => {
    const first = await h.orchestrator.intake(issue(), 'webhook');
    h.store.transition(first.remediation!.id, 'failed', { error: 'boom' });

    const retry = await h.orchestrator.intake(issue(), 'comment:retry');
    expect(retry.accepted).toBe(true);
    expect(retry.remediation?.attempt).toBe(2);
  });

  /**
   * The gap that cost this deployment two duplicate sessions: a finished
   * remediation is terminal, but the issue stays open until its PR merges, so
   * the periodic scanner saw fresh work every sweep.
   */
  it('refuses an issue whose fix is already open as a pull request', async () => {
    const first = await h.orchestrator.intake(issue(), 'webhook');
    h.store.transition(first.remediation!.id, 'succeeded', {
      prUrl: 'https://github.com/watilde/superset/pull/6',
    });
    h.store.recordPullRequest(first.remediation!.id, { state: 'open' });

    const again = await h.orchestrator.intake(issue(), 'scheduled-scan');
    expect(again.accepted).toBe(false);
    expect(again.reason).toMatch(/awaiting review/);
    expect(h.store.listAll()).toHaveLength(1);
  });

  it('refuses an issue that was already fixed and merged', async () => {
    const first = await h.orchestrator.intake(issue(), 'webhook');
    h.store.transition(first.remediation!.id, 'succeeded', {
      prUrl: 'https://github.com/watilde/superset/pull/6',
    });
    h.store.recordPullRequest(first.remediation!.id, { state: 'merged', mergedAt: null });

    const again = await h.orchestrator.intake(issue(), 'scheduled-scan');
    expect(again.accepted).toBe(false);
    expect(again.reason).toMatch(/merged/);
  });

  /**
   * The refinement that actually stopped the bleeding: the attempt holding the
   * pull request is usually not the newest row, because a cancelled duplicate
   * sits on top of it.
   */
  it('finds the pull request even when a later attempt was cancelled', async () => {
    const first = await h.orchestrator.intake(issue(), 'webhook');
    h.store.transition(first.remediation!.id, 'succeeded', {
      prUrl: 'https://github.com/watilde/superset/pull/6',
    });
    h.store.recordPullRequest(first.remediation!.id, { state: 'open' });

    // A duplicate that was dispatched and then stopped, leaving no PR of its own.
    const dup = h.store.create({
      repo: 'watilde/superset',
      issueNumber: issue().number,
      issueUrl: '',
      title: 't',
      contractId: 'SEC-001',
      category: 'security',
      severity: 'high',
      triggeredBy: 'scheduled-scan',
    });
    h.store.transition(dup.id, 'cancelled', { error: 'duplicate' });

    const again = await h.orchestrator.intake(issue(), 'scheduled-scan');
    expect(again.accepted).toBe(false);
    expect(again.reason).toMatch(/awaiting review/);
  });

  /** A PR that was closed unmerged is not a fix, so the work is live again. */
  it('allows a retry after the pull request was closed without merging', async () => {
    const first = await h.orchestrator.intake(issue(), 'webhook');
    h.store.transition(first.remediation!.id, 'succeeded', {
      prUrl: 'https://github.com/watilde/superset/pull/6',
    });
    h.store.recordPullRequest(first.remediation!.id, { state: 'closed' });

    const again = await h.orchestrator.intake(issue(), 'comment:retry');
    expect(again.accepted).toBe(true);
  });
});

describe('dispatch', () => {
  it('creates a Devin session and moves the remediation to running', async () => {
    const h = harness();
    await h.orchestrator.intake(issue(), 'test');
    const started = await h.orchestrator.dispatch();

    expect(started).toBe(1);
    const r = h.store.listAll()[0]!;
    expect(r.state).toBe('running');
    expect(r.devinSessionId).toBeTruthy();
    expect(r.devinSessionUrl).toContain('devin.ai');
  });

  /**
   * Defence in depth: a queued remediation can outlive the state it was
   * accepted in, and the queue is the last place to catch that before a
   * session is paid for.
   */
  it('cancels a queued remediation whose issue got a pull request meanwhile', async () => {
    const h = harness();
    const first = await h.orchestrator.intake(issue(), 'webhook');
    // A sibling attempt, queued behind it, from before the intake gate existed.
    const stale = h.store.create({
      repo: 'watilde/superset',
      issueNumber: issue().number,
      issueUrl: '',
      title: 'duplicate',
      contractId: 'SEC-001',
      category: 'security',
      severity: 'high',
      triggeredBy: 'scheduled-scan',
    });
    h.store.transition(first.remediation!.id, 'succeeded', {
      prUrl: 'https://github.com/watilde/superset/pull/6',
    });
    h.store.recordPullRequest(first.remediation!.id, { state: 'open' });

    expect(await h.orchestrator.dispatch()).toBe(0);
    const after = h.store.get(stale.id)!;
    expect(after.state).toBe('cancelled');
    expect(after.error).toMatch(/superseded/);
  });

  it('respects the concurrency cap', async () => {
    const h = harness();
    // Cap is MAX_CONCURRENT_SESSIONS (default 3); queue more than that.
    for (let n = 1; n <= 5; n++) {
      await h.orchestrator.intake(issue({ number: 200 + n }), 'test');
    }
    const started = await h.orchestrator.dispatch();
    expect(started).toBe(3);
    expect(h.store.listByState(['queued'])).toHaveLength(2);

    // A second pass must not exceed the cap while the first three are live.
    expect(await h.orchestrator.dispatch()).toBe(0);
  });
});

describe('reconcile', () => {
  it('drives a successful session to succeeded with a pull request', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'fixed' }));
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();

    await h.orchestrator.reconcile(); // poll 1 — still working
    await h.orchestrator.reconcile(); // poll 2 — terminal

    const r = h.store.listAll()[0]!;
    expect(r.state).toBe('succeeded');
    expect(r.prUrl).toContain('/pull/');
    expect(r.completedAt).toBeTruthy();
  });

  /**
   * The judgement that keeps the success metric honest: Devin finishing is not
   * the same as Devin succeeding.
   */
  it('records a finished session that opened no pull request as failed', async () => {
    const h = harness(
      new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'finished_no_pr' }),
    );
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    const r = h.store.listAll()[0]!;
    // The mock reports status "no_change_needed", a legitimate conclusion, so
    // this is a success with no PR rather than a failure.
    expect(r.state).toBe('succeeded');
    expect(r.prUrl).toBeNull();
  });

  it('marks a session that ended in error as failed', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'expired' }));
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    const r = h.store.listAll()[0]!;
    expect(r.state).toBe('failed');
    // The provider status is preserved in the error so triage does not need
    // to go back to the Devin UI to find out why.
    expect(r.error).toMatch(/exit\/error/);
  });

  /**
   * The common shape in practice: Devin opens the PR, then stops to ask
   * whether anything else is wanted. The work is on the board while the
   * session is still non-terminal, and the dedup gate depends on seeing it.
   */
  it('records a pull request from a session that is still in flight', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'pr_then_idle' }));
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    const r = h.store.listAll()[0]!;
    expect(r.state).toBe('running'); // not finished — and that is fine
    expect(r.prUrl).toContain('/pull/');
    expect(r.prState).toBe('open');
    // And the gate can now see it, which is the point.
    expect(h.store.findLivePullRequestForIssue(r.repo, r.issueNumber)?.id).toBe(r.id);
  });

  it('surfaces a blocked session without terminating it', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'blocked' }));
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    const r = h.store.listAll()[0]!;
    expect(r.state).toBe('blocked');
    expect(r.completedAt).toBeNull();
  });
});

/**
 * Both of these are regressions, not hypotheticals: they cost this deployment
 * two merge-ready pull requests, which were recorded as timeouts and then
 * re-dispatched as duplicate paid sessions.
 */
describe('evidence outranks the clock', () => {
  /** A session that opened a PR and then idled past the budget still delivered. */
  it('records a timed-out session that had already opened a PR as succeeded', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'pr_then_idle' }));
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();

    // Backdate past SESSION_TIMEOUT_MS so the next pass is over budget.
    const r = h.store.listAll()[0]!;
    h.store.query(
      `UPDATE remediations SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ${r.id}`,
    );
    await h.orchestrator.reconcile();

    const after = h.store.get(r.id)!;
    expect(after.state).toBe('succeeded');
    expect(after.prUrl).toContain('/pull/');
    // The overrun is still recorded — it just is not allowed to erase the work.
    expect(after.error).toMatch(/outlived/);
  });

  it('still times out a session that produced nothing', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 99 }));
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();

    const r = h.store.listAll()[0]!;
    h.store.query(
      `UPDATE remediations SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ${r.id}`,
    );
    await h.orchestrator.reconcile();

    const after = h.store.get(r.id)!;
    expect(after.state).toBe('timed_out');
    expect(after.prUrl).toBeNull();
  });

  it('adopts a pull request the session opened but we never recorded', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'fixed' }));
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    // Simulate the record we would have been left with had the reconciler
    // killed the session before it exited.
    const r = h.store.listAll()[0]!;
    h.store.query(
      `UPDATE remediations SET state = 'timed_out', pr_url = NULL, pr_state = NULL WHERE id = ${r.id}`,
    );

    expect(await h.orchestrator.adoptOrphanedPullRequests()).toBe(1);
    const after = h.store.get(r.id)!;
    expect(after.state).toBe('succeeded');
    expect(after.prUrl).toContain('/pull/');
  });

  it('asks about each orphan once, not on every tick', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'finished_no_pr' }));
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    // A genuine no-change outcome: no PR to find, now or ever.
    expect(await h.orchestrator.adoptOrphanedPullRequests()).toBe(0);
    expect(h.store.listTerminalWithoutPullRequest()).toHaveLength(0);
  });
});

describe('audit trail', () => {
  it('records every state transition as an event', async () => {
    const h = harness();
    await h.orchestrator.intake(issue(), 'webhook:issues.labeled');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    const types = h.store.listEvents().map((e) => e.type);
    expect(types).toContain('remediation.created');
    expect(types).toContain('remediation.transition');

    const states = h.store
      .listEvents()
      .filter((e) => e.type === 'remediation.transition')
      .map((e) => e.toState);
    expect(states).toContain('dispatching');
    expect(states).toContain('running');
    expect(states).toContain('succeeded');
  });
});

describe('operator controls', () => {
  it('cancels a queued remediation so it never dispatches', async () => {
    const h = harness();
    const r = await h.orchestrator.intake(issue(), 'test');
    const cancelled = await h.orchestrator.cancel(r.remediation!.id, 'paused for budget');

    expect(cancelled?.state).toBe('cancelled');
    expect(cancelled?.error).toBe('paused for budget');
    // The point of cancelling: capacity frees without the work starting.
    expect(await h.orchestrator.dispatch()).toBe(0);
  });

  it('leaves an already-terminal remediation alone', async () => {
    const h = harness();
    const r = await h.orchestrator.intake(issue(), 'test');
    h.store.transition(r.remediation!.id, 'succeeded', { prUrl: 'https://x/pull/1' });

    const result = await h.orchestrator.cancel(r.remediation!.id);
    expect(result?.state).toBe('succeeded');
  });

  /**
   * `blocked` is the only non-terminal state the system cannot leave on its
   * own; without a reply path a session sits there until it times out.
   */
  it('returns a blocked remediation to running when answered', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'blocked' }));
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    const blocked = h.store.listAll()[0]!;
    expect(blocked.state).toBe('blocked');

    const replied = await h.orchestrator.reply(blocked.id, 'yes, keep it backwards compatible');
    expect(replied?.state).toBe('running');
    expect(h.store.listEvents().some((e) => e.type === 'remediation.reply')).toBe(true);
  });

  it('refuses an unknown remediation', async () => {
    const h = harness();
    expect(await h.orchestrator.reply(9999, 'hello')).toBeNull();
    expect(await h.orchestrator.cancel(9999)).toBeNull();
  });
});

/**
 * The review-fix loop is the part of this system that a deterministic bot
 * cannot have: when CI rejects the patch, the failure goes back to the agent
 * that wrote it, with its original context, instead of to a human's queue.
 *
 * All of these drive a remediation to `succeeded` with a pull request first,
 * because that is the only state a CI result can arrive in.
 */
describe('review-fix loop', () => {
  async function shipped(devin = new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'fixed' })) {
    const h = harness(devin);
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();
    const r = h.store.listAll()[0]!;
    expect(r.state).toBe('succeeded');
    return { ...h, remediation: r, branch: `autopilot/sec-001-issue-${r.issueNumber}` };
  }

  it('sends a CI failure back to the session and reopens the work', async () => {
    const h = await shipped();

    const result = await h.orchestrator.handleCiResult({
      branch: h.branch,
      conclusion: 'failure',
      runId: 42,
      runUrl: 'https://github.com/watilde/superset/actions/runs/42',
    });

    expect(result.handled).toBe(true);
    const r = h.store.get(h.remediation.id)!;
    expect(r.ciStatus).toBe('failed');
    expect(r.reworks).toBe(1);
    // Back out of terminal: CI rejected the patch, so the work is genuinely
    // in flight again and the dashboard must not still be claiming success.
    expect(r.state).toBe('running');

    const sent = h.devin.messages.at(-1)!;
    expect(sent.sessionId).toBe(r.devinSessionId);
    expect(sent.message).toMatch(/CI failed/);
    expect(sent.message).toContain(h.branch);
    expect(sent.message).toContain('runs/42');
  });

  it('leaves a passing build alone', async () => {
    const h = await shipped();

    await h.orchestrator.handleCiResult({
      branch: h.branch,
      conclusion: 'success',
      runId: 43,
      runUrl: null,
    });

    const r = h.store.get(h.remediation.id)!;
    expect(r.ciStatus).toBe('passed');
    expect(r.state).toBe('succeeded');
    expect(r.reworks).toBe(0);
    expect(h.devin.messages).toHaveLength(0);
  });

  /**
   * An agent that cannot fix its own build twice is stuck on something the
   * contract did not anticipate. Looping past that point spends ACUs to learn
   * nothing, so the cap escalates instead.
   */
  it('escalates to a human once the rework cap is reached', async () => {
    const h = await shipped();
    const fail = () =>
      h.orchestrator.handleCiResult({
        branch: h.branch,
        conclusion: 'failure',
        runId: 44,
        runUrl: null,
      });

    await fail(); // rework 1
    await fail(); // rework 2 — MAX_CI_REWORKS
    const messagesBeforeCap = h.devin.messages.length;

    const capped = await fail();
    expect(capped.reason).toMatch(/escalated/);
    // Nothing further is sent: the point of the cap is to stop spending.
    expect(h.devin.messages).toHaveLength(messagesBeforeCap);
    expect(h.store.get(h.remediation.id)!.reworks).toBe(2);
  });

  /**
   * Two failing runs both read `failed`. Keying on the status alone would
   * either resend the first failure forever or ignore the second one.
   */
  it('treats a second failing run as a new verdict', async () => {
    const h = await shipped();
    const fail = (runId: number) =>
      h.orchestrator.handleCiResult({
        branch: h.branch,
        conclusion: 'failure',
        runId,
        runUrl: `https://github.com/watilde/superset/actions/runs/${runId}`,
      });

    await fail(101);
    expect(h.store.get(h.remediation.id)!.ciRunId).toBe(101);

    await fail(102);
    const r = h.store.get(h.remediation.id)!;
    expect(r.ciRunId).toBe(102);
    expect(r.reworks).toBe(2);
    expect(h.devin.messages).toHaveLength(2);
  });

  it('ignores CI on a branch it does not own', async () => {
    const h = await shipped();
    const result = await h.orchestrator.handleCiResult({
      branch: 'feature/someone-elses-work',
      conclusion: 'failure',
      runId: 45,
      runUrl: null,
    });
    expect(result.handled).toBe(false);
    expect(h.devin.messages).toHaveLength(0);
  });
});

/**
 * Opening a pull request is output; merging one is outcome. These are tracked
 * separately so the dashboard cannot report the first as though it were the
 * second.
 */
describe('pull request outcomes', () => {
  it('stamps when the pull request first appeared', async () => {
    const h = harness();
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    const r = h.store.listAll()[0]!;
    expect(r.prOpenedAt).toBeTruthy();
    expect(r.prState).toBe('open');
    expect(r.prMergedAt).toBeNull();
  });

  it('records a merge from a webhook and holds the opened-at stamp', async () => {
    const h = harness();
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();
    const before = h.store.listAll()[0]!;

    const updated = h.orchestrator.recordPullRequestEvent({
      url: before.prUrl!,
      state: 'merged',
      mergedAt: '2026-01-01T00:00:00.000Z',
      branch: `autopilot/sec-001-issue-${before.issueNumber}`,
    });

    expect(updated?.prState).toBe('merged');
    expect(updated?.prMergedAt).toBe('2026-01-01T00:00:00.000Z');
    // Time-to-fix ends when the PR opened; a later merge must not move it.
    expect(updated?.prOpenedAt).toBe(before.prOpenedAt);
    expect(h.store.listEvents().some((e) => e.type === 'pull_request.merged')).toBe(true);
  });

  it('ignores a pull request from a branch it does not own', async () => {
    const h = harness();
    await h.orchestrator.intake(issue(), 'test');
    expect(
      h.orchestrator.recordPullRequestEvent({
        url: 'https://github.com/watilde/superset/pull/999',
        state: 'merged',
        mergedAt: null,
        branch: 'dependabot/npm_and_yarn/lodash',
      }),
    ).toBeNull();
  });
});

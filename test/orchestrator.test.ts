import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db/index.js';
import type { RemediationState } from '../src/types.js';
import { DevinMockClient } from '../src/devin/mock.js';
import { GitHubClient, type IssueRef } from '../src/github/client.js';
import { Orchestrator, type AutoMergePolicy } from '../src/core/orchestrator.js';
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

/**
 * A GitHub that remembers. The default client in this harness has no token and
 * is inert, which is right for every test that only cares about state — but
 * labels are the one output that lives entirely on GitHub, so asserting on them
 * needs something that records.
 */
class RecordingGitHub extends GitHubClient {
  labels = new Map<number, Set<string>>();

  constructor(seed: Record<number, string[]> = {}) {
    // No token, so every method this class does not override stays inert and
    // no test can reach the network. Only the label surface is real.
    super(undefined, 'watilde', 'superset');
    for (const [n, ls] of Object.entries(seed)) this.labels.set(Number(n), new Set(ls));
  }

  labelsOn(issueNumber: number): string[] {
    return [...(this.labels.get(issueNumber) ?? [])].sort();
  }

  override get enabled(): boolean {
    return true;
  }

  override async getIssue(number: number) {
    return {
      number,
      title: 't',
      body: null,
      htmlUrl: '',
      labels: this.labelsOn(number),
      state: 'open',
    };
  }

  override async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    const set = this.labels.get(issueNumber) ?? new Set<string>();
    for (const l of labels) set.add(l);
    this.labels.set(issueNumber, set);
  }

  override async removeLabel(issueNumber: number, label: string): Promise<void> {
    this.labels.get(issueNumber)?.delete(label);
  }

  override async comment(): Promise<void> {}
}

function harness(mock?: DevinMockClient, autoMerge?: AutoMergePolicy, gh?: GitHubClient) {
  const store = new Store(':memory:');
  const devin = mock ?? new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'fixed' });
  // No token → GitHub is inert, which is exactly the demo/offline path.
  const github = gh ?? new GitHubClient(undefined, 'watilde', 'superset');
  // Omitting the policy leaves the orchestrator on its shipped default, which
  // is how the "off unless asked for" tests get their subject.
  return { store, devin, github, orchestrator: new Orchestrator(store, devin, github, autoMerge) };
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

  /**
   * The rule that CI outranks the agent's self-report has to work in both
   * directions, or it is just a rule about which errors we prefer to keep.
   * QUAL-002 hit this: Devin reported `blocked` because the contract's own
   * type-check could not pass, the contract was fixed, and CI then went green
   * on the same pull request while the record still said `failed`.
   */
  it('corrects a failed record when CI later passes on its pull request', async () => {
    const h = await shipped();
    const id = h.remediation.id;
    h.store.transition(id, 'failed', { error: 'Devin reported it was blocked' });

    const result = await h.orchestrator.handleCiResult({
      branch: h.branch,
      conclusion: 'success',
      runId: 77,
      runUrl: null,
    });

    expect(result.reason).toMatch(/corrected/);
    const r = h.store.get(id)!;
    expect(r.state).toBe('succeeded');
    expect(r.error).toBeNull();
  });

  it('does not promote a remediation that produced no pull request', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'expired' }));
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    const r = h.store.listAll()[0]!;
    expect(r.state).toBe('failed');
    expect(r.prUrl).toBeNull();

    await h.orchestrator.handleCiResult({
      branch: `autopilot/sec-001-issue-${r.issueNumber}`,
      conclusion: 'success',
      runId: 78,
      runUrl: null,
    });
    expect(h.store.get(r.id)!.state).toBe('failed');
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
 * Merging is the one irreversible step in this system: a wrong patch sits in a
 * pull request until somebody looks, a wrong state correction is one comment,
 * but a merge lands the change in the branch people deploy from. So the gate
 * gets its own tests, and most of them are about the cases that must *not*
 * merge.
 */
describe('auto-merge', () => {
  const CODE_QUALITY: AutoMergePolicy = { enabled: true, categories: ['code-quality'], graceMs: 600_000 };

  /** QUAL-001 — the real PR #10's contract, and a category that is allowlisted. */
  const qualityIssue = () =>
    issue({
      number: 103,
      title: SEED_ISSUES[2]!.title,
      body: SEED_ISSUES[2]!.body,
      labels: ['autopilot', 'code-quality'],
    });

  // The policy is always passed explicitly: `undefined` has to mean "leave the
  // orchestrator on its own default", and a default parameter would swallow it.
  async function green(policy: AutoMergePolicy | undefined, seed = qualityIssue()) {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'fixed' }), policy);
    await h.orchestrator.intake(seed, 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();

    const r = h.store.listAll()[0]!;
    expect(r.state).toBe('succeeded');
    expect(r.prUrl).toBeTruthy();
    return {
      ...h,
      remediation: r,
      branch: `autopilot/${r.contractId!.toLowerCase()}-issue-${r.issueNumber}`,
      pass: (runId = 90) =>
        h.orchestrator.handleCiResult({
          branch: `autopilot/${r.contractId!.toLowerCase()}-issue-${r.issueNumber}`,
          conclusion: 'success',
          runId,
          runUrl: null,
        }),
    };
  }

  it('asks the session that opened the pull request to merge it', async () => {
    const h = await green(CODE_QUALITY);
    const result = await h.pass();

    expect(result.reason).toMatch(/merge requested/);
    const sent = h.devin.messages.at(-1)!;
    expect(sent.sessionId).toBe(h.remediation.devinSessionId);
    expect(sent.message).toContain(h.remediation.prUrl!);
    expect(sent.message).toMatch(/merge/i);
    expect(h.store.get(h.remediation.id)!.mergeRequestedAt).toBeTruthy();
  });

  /**
   * The instruction has to rule out the shortcuts, because "get this merged" is
   * exactly the prompt under which an agent starts disabling checks.
   */
  it('tells the session not to force the merge or weaken a check to get it', async () => {
    const h = await green(CODE_QUALITY);
    await h.pass();

    const sent = h.devin.messages.at(-1)!.message;
    expect(sent).toMatch(/do not force it through/i);
    expect(sent).toMatch(/do not disable a check/i);
    expect(sent).toMatch(/stop\s+and say why/i);
  });

  /**
   * Asking is not merging. If Devin never performs it, the honest reading is a
   * pull request still sitting open — not a shipped fix — and only GitHub gets
   * to move `pr_state`.
   */
  it('records that it asked, never that the pull request merged', async () => {
    const h = await green(CODE_QUALITY);
    await h.pass();

    const r = h.store.get(h.remediation.id)!;
    expect(r.mergeRequestedAt).toBeTruthy();
    expect(r.prState).toBe('open');
    expect(r.prMergedAt).toBeNull();
  });

  it('is off unless it was asked for', async () => {
    const h = await green(undefined); // orchestrator default: AUTO_MERGE is false
    const result = await h.pass();

    expect(result.reason).not.toMatch(/merge/);
    expect(h.devin.messages).toHaveLength(0);
    expect(h.store.get(h.remediation.id)!.mergeRequestedAt).toBeNull();
  });

  /**
   * The floor that a configuration mistake must not be able to remove. A
   * passing test suite is not the thing that makes a security fix safe to ship
   * — somebody who understands the threat agreeing that it addresses it is.
   */
  it('refuses a security change even when the allowlist names it', async () => {
    const h = await green({ enabled: true, categories: ['security', 'code-quality'], graceMs: 600_000 }, issue());
    expect(h.remediation.category).toBe('security');

    await h.pass();
    expect(h.devin.messages).toHaveLength(0);
    expect(h.store.get(h.remediation.id)!.mergeRequestedAt).toBeNull();
  });

  it('leaves a category off the allowlist alone', async () => {
    const h = await green({ enabled: true, categories: ['dependency'], graceMs: 600_000 });
    await h.pass();

    expect(h.devin.messages).toHaveLength(0);
    expect(h.store.get(h.remediation.id)!.mergeRequestedAt).toBeNull();
  });

  /**
   * CI is polled every reconcile tick and the same green run is re-read every
   * time. Without the stamp this would resend the instruction forever, which is
   * both noise in the session and a standing invitation to merge something the
   * operator has since closed.
   */
  it('asks exactly once, however often the same green run is re-read', async () => {
    const h = await green(CODE_QUALITY);
    await h.pass();
    expect(h.devin.messages).toHaveLength(1);
    const stamp = h.store.get(h.remediation.id)!.mergeRequestedAt;

    await h.pass();
    await h.pass(91);

    expect(h.devin.messages).toHaveLength(1);
    expect(h.store.get(h.remediation.id)!.mergeRequestedAt).toBe(stamp);
  });

  it('does not chase a pull request that is already closed', async () => {
    const h = await green(CODE_QUALITY);
    h.store.recordPullRequest(h.remediation.id, { state: 'closed' });

    await h.pass();
    expect(h.devin.messages).toHaveLength(0);
    expect(h.store.get(h.remediation.id)!.mergeRequestedAt).toBeNull();
  });

  it('does not ask while CI is still failing', async () => {
    const h = await green(CODE_QUALITY);
    await h.orchestrator.handleCiResult({
      branch: h.branch,
      conclusion: 'failure',
      runId: 92,
      runUrl: null,
    });

    // One message, and it is the rework — not a merge request.
    expect(h.devin.messages).toHaveLength(1);
    expect(h.devin.messages[0]!.message).toMatch(/CI failed/);
    expect(h.store.get(h.remediation.id)!.mergeRequestedAt).toBeNull();
  });

  /**
   * The gap where this system could go quiet: asked, never merged, and the
   * reason only in a session transcript nobody watches.
   *
   * Devin's tooling refuses to merge into `main`/`master` unconditionally —
   * discovered on the first live run, and not a rule any configuration here
   * could have anticipated. So the trigger is the observable fact, not a guess
   * about the prose: asked, grace elapsed, still open.
   */
  describe('when the merge never happens', () => {
    const NO_GRACE: AutoMergePolicy = { ...CODE_QUALITY, graceMs: 0 };

    async function asked(policy: AutoMergePolicy = NO_GRACE) {
      const h = await green(policy);
      await h.pass();
      expect(h.store.get(h.remediation.id)!.mergeRequestedAt).toBeTruthy();
      return h;
    }

    const escalation = (h: Awaited<ReturnType<typeof asked>>) =>
      h.store.listEvents(50).find((e) => e.type === 'merge.escalated');

    it('hands it to a human, quoting what the session said', async () => {
      const h = await asked();
      expect(await h.orchestrator.escalateUnperformedMerges()).toBe(1);

      const r = h.store.get(h.remediation.id)!;
      expect(r.mergeEscalatedAt).toBeTruthy();
      // The agent's own words are the record — Autopilot does not paraphrase a
      // refusal it did not make.
      expect((escalation(h)!.detail as { reason: string }).reason).toBeTruthy();
    });

    it('waits out the grace period before deciding the merge failed', async () => {
      const h = await asked(CODE_QUALITY); // ten minutes, so nothing is due yet
      expect(await h.orchestrator.escalateUnperformedMerges()).toBe(0);
      expect(h.store.get(h.remediation.id)!.mergeEscalatedAt).toBeNull();
    });

    it('says nothing when the merge did happen', async () => {
      const h = await asked();
      h.store.recordPullRequest(h.remediation.id, {
        state: 'merged',
        mergedAt: '2026-08-02T20:00:00.000Z',
      });

      expect(await h.orchestrator.escalateUnperformedMerges()).toBe(0);
      expect(h.store.get(h.remediation.id)!.mergeEscalatedAt).toBeNull();
    });

    it('escalates once and then stops — Autopilot does not nag', async () => {
      const h = await asked();
      expect(await h.orchestrator.escalateUnperformedMerges()).toBe(1);
      const stamp = h.store.get(h.remediation.id)!.mergeEscalatedAt;

      expect(await h.orchestrator.escalateUnperformedMerges()).toBe(0);
      expect(h.store.get(h.remediation.id)!.mergeEscalatedAt).toBe(stamp);
    });

    /** Nothing was asked of it, so there is nothing to escalate. */
    it('leaves an open pull request alone when no merge was ever requested', async () => {
      const h = await green(undefined); // auto-merge off
      await h.pass();

      expect(await h.orchestrator.escalateUnperformedMerges()).toBe(0);
      expect(h.store.get(h.remediation.id)!.mergeEscalatedAt).toBeNull();
    });
  });
});

/**
 * The issue thread is where anyone outside the team actually looks, and for a
 * long time it disagreed with the record: four of five issues wore
 * `timed_out`, `failed` or `needs-human` while their pull requests were merged,
 * because the write path added labels and never removed them. A dashboard
 * saying 100% next to issues saying "failed" is worse than either being wrong
 * on its own — it makes the honest number unbelievable too.
 */
describe('issue labels', () => {
  /**
   * State is built directly rather than driven through the pipeline: these
   * assert what the labels become, and threading a whole session through a
   * GitHub double would only add ways for the setup to be the thing that broke.
   */
  function withLabels(seed: string[], state: RemediationState, opts: { merged?: boolean } = {}) {
    const github = new RecordingGitHub({ 101: seed });
    const h = harness(undefined, undefined, github);
    const r = h.store.create({
      repo: 'watilde/superset',
      issueNumber: 101,
      issueUrl: '',
      title: 'Unsafe YAML deserialization',
      contractId: 'SEC-001',
      category: 'security',
      severity: 'high',
      triggeredBy: 'test',
    });
    h.store.transition(r.id, state, {
      prUrl: 'https://github.com/watilde/superset/pull/6',
      devinSessionId: 'session-1',
      error: state === 'succeeded' ? null : 'reported blocked',
    });
    h.store.recordPullRequest(r.id, {
      state: opts.merged ? 'merged' : 'open',
      mergedAt: opts.merged ? '2026-08-03T03:56:49Z' : null,
    });
    return { ...h, github, remediation: h.store.get(r.id)! };
  }

  it('moves the outcome label instead of stacking a rival next to it', async () => {
    const h = withLabels(['autopilot', 'security', 'autopilot:timed_out'], 'failed');

    // CI going green corrects the record; the label has to follow it.
    await h.orchestrator.handleCiResult({
      branch: 'autopilot/sec-001-issue-101',
      conclusion: 'success',
      runId: 501,
      runUrl: null,
    });

    expect(h.store.get(h.remediation.id)!.state).toBe('succeeded');
    const labels = h.github.labelsOn(101);
    expect(labels).toContain('autopilot:succeeded');
    expect(labels).not.toContain('autopilot:timed_out');
    // Labels this system does not own are left alone.
    expect(labels).toContain('security');
  });

  it('repairs drift and reports how much it found', async () => {
    const h = withLabels(['autopilot', 'autopilot:timed_out'], 'succeeded');

    expect(await h.orchestrator.reconcileIssueLabels()).toBe(1);
    expect(h.github.labelsOn(101)).toEqual(['autopilot', 'autopilot:succeeded']);

    // Idempotent: nothing left to fix on a second pass.
    expect(await h.orchestrator.reconcileIssueLabels()).toBe(0);
  });

  /** `needs-human` is a request, not a state: it ends when it is answered. */
  it('keeps needs-human while the pull request is still open', async () => {
    const h = withLabels(['autopilot', 'autopilot:needs-human'], 'succeeded');

    await h.orchestrator.reconcileIssueLabels();
    expect(h.github.labelsOn(101)).toContain('autopilot:needs-human');
  });

  /**
   * The hazard the dedup gate already knew about, arriving here too: the
   * attempt that shipped is usually not the newest row, because a duplicate
   * that was correctly cancelled sits on top of it. Labelling from the newest
   * row put `autopilot:cancelled` on issues whose fixes were merged — caught
   * by running the repair against the real fork, not by the suite.
   */
  it('labels from the attempt that shipped, not the newest one', async () => {
    const h = withLabels(['autopilot', 'autopilot:timed_out'], 'succeeded', { merged: true });

    // A later duplicate that was stopped before it could open anything.
    const dup = h.store.create({
      repo: 'watilde/superset',
      issueNumber: 101,
      issueUrl: '',
      title: 'duplicate',
      contractId: 'SEC-001',
      category: 'security',
      severity: 'high',
      triggeredBy: 'scheduled-scan',
    });
    h.store.transition(dup.id, 'cancelled', { error: 'duplicate' });

    await h.orchestrator.reconcileIssueLabels();
    expect(h.github.labelsOn(101)).toEqual(['autopilot', 'autopilot:succeeded']);
  });

  it('clears needs-human once the pull request merged', async () => {
    const h = withLabels(['autopilot', 'autopilot:needs-human'], 'succeeded', { merged: true });

    expect(await h.orchestrator.reconcileIssueLabels()).toBe(1);
    expect(h.github.labelsOn(101)).toEqual(['autopilot', 'autopilot:succeeded']);
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

/**
 * The half of review that is not CI.
 *
 * CI answers a question the contract already asked. A reviewer asks one it
 * did not, which is why this loop is counted, capped and escalated separately —
 * and why the reviewer's identity never appears in the routing. A person and a
 * second agent submit the same event.
 */
describe('review loop', () => {
  async function shipped(autoMerge?: AutoMergePolicy) {
    const h = harness(
      new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'fixed' }),
      autoMerge,
    );
    await h.orchestrator.intake(issue(), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();
    const r = h.store.listAll()[0]!;
    expect(r.state).toBe('succeeded');
    return { ...h, remediation: r, branch: `autopilot/sec-001-issue-${r.issueNumber}` };
  }

  const review = (state: string, body: string | null = 'use the existing helper') => ({
    state,
    body,
    reviewer: 'a-human',
    reviewUrl: 'https://github.com/watilde/superset/pull/1#pullrequestreview-1',
  });

  it('sends a change request back to the session and reopens the work', async () => {
    const h = await shipped();

    const result = await h.orchestrator.handleReview({
      branch: h.branch,
      ...review('changes_requested'),
    });

    expect(result.handled).toBe(true);
    const r = h.store.get(h.remediation.id)!;
    expect(r.reviewReworks).toBe(1);
    // Counted apart from CI: nothing here says the agent's own build was wrong.
    expect(r.reworks).toBe(0);
    expect(r.state).toBe('running');

    const sent = h.devin.messages.at(-1)!;
    expect(sent.sessionId).toBe(r.devinSessionId);
    expect(sent.message).toMatch(/requested changes/);
    expect(sent.message).toContain(h.branch);
    expect(sent.message).toContain('use the existing helper');
  });

  /**
   * Comments are how people think out loud on a pull request. Treating each one
   * as an instruction would spend ACUs on somebody's aside.
   */
  it('ignores a review that only comments', async () => {
    const h = await shipped();

    const result = await h.orchestrator.handleReview({
      branch: h.branch,
      ...review('commented', 'nice'),
    });

    expect(result.handled).toBe(false);
    const r = h.store.get(h.remediation.id)!;
    expect(r.reviewReworks).toBe(0);
    expect(r.state).toBe('succeeded');
    expect(h.devin.messages).toHaveLength(0);
  });

  /**
   * The two gates are independent. A reviewer who has not read the failing run
   * is not evidence that it passes, so approval alone must not merge.
   */
  it('does not merge on approval alone when CI has not passed', async () => {
    // Auto-merge on, so the gate that refuses is the build rather than the
    // policy — otherwise this test passes for the wrong reason.
    const h = await shipped({ enabled: true, categories: ['code-quality'] });

    const result = await h.orchestrator.handleReview({
      branch: h.branch,
      ...review('approved', null),
    });

    expect(result.handled).toBe(true);
    expect(result.reason).toMatch(/ci has not passed/);
    expect(h.store.get(h.remediation.id)!.mergeRequestedAt).toBeNull();
  });

  it('requests the merge when an approval lands on a build CI already passed', async () => {
    const h = harness(
      new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'fixed' }),
      { enabled: true, categories: ['security', 'code-quality'] },
    );
    await h.orchestrator.intake(issue({ number: 202 }), 'test');
    await h.orchestrator.dispatch();
    await h.orchestrator.reconcile();
    await h.orchestrator.reconcile();
    const r0 = h.store.listAll()[0]!;
    const branch = `autopilot/sec-001-issue-${r0.issueNumber}`;

    h.store.recordCi(r0.id, 'passed');
    // `security` is refused unconditionally, so this asserts the approval path
    // reaches the merge gate rather than that it opens it.
    const result = await h.orchestrator.handleReview({ branch, ...review('approved', null) });

    expect(result.handled).toBe(true);
    expect(result.reason).toMatch(/never merge unattended/);
  });

  /**
   * Repeated change requests usually mean the contract did not say something it
   * needed to. That is a question for a person, not for another paid attempt.
   */
  it('escalates to a human once the review cap is reached', async () => {
    const h = await shipped();
    const ask = () =>
      h.orchestrator.handleReview({ branch: h.branch, ...review('changes_requested') });

    await ask();
    await ask(); // MAX_REVIEW_REWORKS
    const messagesBeforeCap = h.devin.messages.length;

    const capped = await ask();
    expect(capped.reason).toMatch(/cap reached/);
    // Nothing further is sent: the point of the cap is to stop spending.
    expect(h.devin.messages).toHaveLength(messagesBeforeCap);
    expect(h.store.get(h.remediation.id)!.reviewReworks).toBe(2);
  });

  it('ignores a review on a branch it does not own', async () => {
    const h = await shipped();

    const result = await h.orchestrator.handleReview({
      branch: 'feature/someone-elses-work',
      ...review('changes_requested'),
    });

    expect(result.handled).toBe(false);
    expect(h.devin.messages).toHaveLength(0);
  });
});

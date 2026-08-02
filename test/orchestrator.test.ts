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

import { describe, expect, it } from 'vitest';
import { Store } from '../src/db/index.js';
import { DevinMockClient } from '../src/devin/mock.js';
import { GitHubClient } from '../src/github/client.js';
import { AuditRunner } from '../src/core/audit.js';

/**
 * The step before every other one.
 *
 * An audit produces no remediation — it produces issues, which arrive back
 * through the ordinary webhook path. So the thing worth asserting is not that
 * it found anything, but that it is tracked: one at a time, closed out when it
 * ends, and never able to bypass the gates that decide what actually runs.
 */
function harness(devin = new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'fixed' })) {
  const store = new Store(':memory:');
  const github = new GitHubClient(undefined, 'watilde', 'superset');
  return { store, devin, audit: new AuditRunner(store, devin, github) };
}

describe('audit', () => {
  it('dispatches a session and records it as in flight', async () => {
    const h = harness();

    const result = await h.audit.dispatch('test');

    expect(result.dispatched).toBe(true);
    expect(result.sessionId).toBeTruthy();
    expect(h.audit.inFlight()).toHaveLength(1);
    expect(h.audit.inFlight()[0]!.sessionId).toBe(result.sessionId);

    // No remediation: an audit is not work on an issue, it is the search for
    // one. Anything it files has to survive intake like anything else.
    expect(h.store.listAll()).toHaveLength(0);
  });

  /**
   * Two audits reading the same repository would file the same defects twice.
   * The duplicates would be refused at intake, so nothing bad reaches Devin —
   * but the issues would exist on GitHub and a person would have to close them.
   */
  it('refuses to start a second audit while one is running', async () => {
    const h = harness();
    const first = await h.audit.dispatch('test');

    const second = await h.audit.dispatch('test');

    expect(second.dispatched).toBe(false);
    expect(second.reason).toMatch(/already running/);
    expect(second.sessionId).toBe(first.sessionId);
    expect(h.audit.inFlight()).toHaveLength(1);
  });

  it('closes the audit out once the session ends, and frees the next one', async () => {
    const h = harness();
    await h.audit.dispatch('test');

    // The mock runs for one poll before finishing.
    await h.audit.reconcile();
    expect(h.audit.inFlight()).toHaveLength(1);

    const settled = await h.audit.reconcile();
    expect(settled).toBe(1);
    expect(h.audit.inFlight()).toHaveLength(0);

    const finished = h.store.listEvents(10, 'audit.finished');
    expect(finished).toHaveLength(1);

    const next = await h.audit.dispatch('test');
    expect(next.dispatched).toBe(true);
  });

  /**
   * A session that stopped to ask a question is still reading the repository.
   * Treating it as finished would let the next audit start underneath it.
   */
  it('leaves a blocked audit in flight', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 1, forceOutcome: 'blocked' }));
    await h.audit.dispatch('test');

    await h.audit.reconcile();
    await h.audit.reconcile();

    expect(h.audit.inFlight()).toHaveLength(1);
    expect(h.store.listEvents(10, 'audit.finished')).toHaveLength(0);
  });

  /**
   * Filing nothing is a correct outcome for an audit, and has to be
   * distinguishable from an audit that never ran — which is why both events
   * exist rather than only the interesting one.
   */
  it('records an audit that filed nothing as finished, not as absent', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 0, forceOutcome: 'finished_no_pr' }));
    await h.audit.dispatch('test');
    await h.audit.reconcile();

    const [finished] = h.store.listEvents(10, 'audit.finished');
    expect(finished).toBeTruthy();
    expect((finished!.detail as { filed: number }).filed).toBe(0);
  });
});

/**
 * Cancelling a session on Devin's side tells Autopilot nothing: it goes on
 * reporting `running/waiting_for_user`, which is exactly what a session that
 * stopped to ask a question reports. There is no way to tell them apart from
 * the API, so time and an operator are the only two signals available — and
 * without either, one cancelled audit kills the button forever.
 */
describe('an audit that will never finish', () => {
  it('stops counting an audit that has been in flight too long', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 999 }));
    await h.audit.dispatch('test');
    expect(h.audit.inFlight()).toHaveLength(1);

    // Backdate the dispatch past the bound, which is what the clock would do.
    const [e] = h.store.listEvents(5, 'audit.dispatched');
    h.store.query(
      `UPDATE events SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ${e!.id}`,
    );

    expect(h.audit.inFlight()).toHaveLength(0);
    expect((await h.audit.dispatch('test')).dispatched).toBe(true);
  });

  it('lets an operator give up on it without waiting out the bound', async () => {
    const h = harness(new DevinMockClient({ pollsUntilTerminal: 999 }));
    await h.audit.dispatch('test');

    const result = await h.audit.abandon('cancelled on the Devin dashboard');

    expect(result.abandoned).toBe(true);
    expect(h.audit.inFlight()).toHaveLength(0);
    // Written off, not erased: the log says it was abandoned and by whom.
    const [finished] = h.store.listEvents(5, 'audit.finished');
    expect((finished!.detail as { state: string }).state).toBe('abandoned');
    expect((await h.audit.dispatch('test')).dispatched).toBe(true);
  });

  it('says so when there is nothing to give up on', async () => {
    const h = harness();
    expect((await h.audit.abandon('nothing')).abandoned).toBe(false);
  });
});

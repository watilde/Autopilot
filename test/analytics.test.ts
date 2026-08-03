import { describe, expect, it } from 'vitest';
import { Store } from '../src/db/index.js';
import { buildAnalytics } from '../src/obs/analytics.js';

function seed() {
  const store = new Store(':memory:');
  const mk = (n: number, category: string, severity: string) =>
    store.create({
      repo: 'watilde/superset',
      issueNumber: n,
      issueUrl: `https://github.com/watilde/superset/issues/${n}`,
      title: `issue ${n}`,
      contractId: `X-00${n}`,
      category,
      severity,
      triggeredBy: 'test',
    });

  const a = mk(1, 'security', 'high');
  const b = mk(2, 'security', 'high');
  const c = mk(3, 'code-quality', 'low');
  const d = mk(4, 'dependency', 'medium');

  store.transition(a.id, 'succeeded', { prUrl: 'https://github.com/x/y/pull/1', acuUsed: 4 });
  store.transition(b.id, 'failed', { error: 'verification commands did not pass', acuUsed: 2 });
  store.transition(c.id, 'succeeded', { acuUsed: 1 }); // valid conclusion, no PR
  // d stays in flight
  return { store, ids: { a: a.id, b: b.id, c: c.id, d: d.id } };
}

describe('analytics', () => {
  it('counts outcomes and separates PRs from other successes', () => {
    const { store } = seed();
    const a = buildAnalytics(store);

    expect(a.totals.total).toBe(4);
    expect(a.totals.completed).toBe(3);
    expect(a.totals.active).toBe(1);
    expect(a.totals.succeeded).toBe(2);
    expect(a.totals.failed).toBe(1);
    expect(a.totals.prsOpened).toBe(1);
    // A success that changed no code is tracked separately from a shipped fix.
    expect(a.totals.falsePositives).toBe(1);
  });

  /**
   * The rate must be computed over completed work. If in-flight items counted
   * in the denominator, labelling a new issue would appear to make the system
   * worse, and the dashboard number would be meaningless.
   */
  it('computes success rate over completed work only', () => {
    const { store } = seed();
    const a = buildAnalytics(store);
    expect(a.successRate).toBeCloseTo(2 / 3, 5);
    expect(a.prRate).toBeCloseTo(1 / 3, 5);
  });

  /**
   * A cancellation is a decision, not a verdict: the operator withdrew the
   * work before the agent could be right or wrong about it. Leaving it in the
   * denominator would make "we paused three issues for budget" read as three
   * failures.
   */
  it('excludes withdrawn work from the success rate but keeps it visible', () => {
    const { store, ids } = seed();
    store.transition(ids.d, 'cancelled', { error: 'paused for budget' });

    const a = buildAnalytics(store);
    expect(a.totals.cancelled).toBe(1);
    expect(a.totals.completed).toBe(4); // everything that stopped
    expect(a.totals.concluded).toBe(3); // everything that reached a verdict
    expect(a.successRate).toBeCloseTo(2 / 3, 5);
    expect(a.byState.find((s) => s.state === 'cancelled')?.count).toBe(1);
  });

  /**
   * The same argument applies to every chart the withdrawal would appear in,
   * not just the headline rate. A duplicate stopped ten seconds after it was
   * queued is a very fast nothing: averaged into cycle time it makes the system
   * look quicker than it is, plotted on the throughput bars it reads as work
   * delivered, and its cancellation note filed under "why things failed" sends
   * the next reader after a problem nobody has.
   */
  it('keeps withdrawn work out of cycle time, throughput and failure reasons', () => {
    const store = new Store(':memory:');
    const r = store.create({
      repo: 'watilde/superset',
      issueNumber: 9,
      issueUrl: '',
      title: 'already fixed upstream',
      contractId: 'DEP-001',
      category: 'dependency',
      severity: 'medium',
      triggeredBy: 'test',
    });
    store.transition(r.id, 'cancelled', { error: 'duplicate of #4' });

    const a = buildAnalytics(store);
    expect(a.totals.completed).toBe(1); // it stopped, and stays visible
    expect(a.totals.concluded).toBe(0); // but it was never judged
    // Null, not zero: nothing here was ever timed, and a zero would be a claim.
    expect(a.cycleTimeSeconds.p50).toBeNull();
    expect(a.cycleTimeSeconds.mean).toBeNull();
    expect(a.throughput).toEqual([]);
    expect(a.failureReasons).toEqual([]);
  });

  it('files an operator note under withdrawals, not under failures', () => {
    const { store, ids } = seed();
    store.transition(ids.d, 'cancelled', { error: 'paused for budget' });

    const reasons = buildAnalytics(store).failureReasons.map((f) => f.reason);
    expect(reasons).toEqual(['verification commands did not pass']);
  });

  it('reports no category success rate when that category was only withdrawn', () => {
    const { store, ids } = seed();
    store.transition(ids.d, 'cancelled', { error: 'duplicate of #4' });

    const dep = buildAnalytics(store).byCategory.find((c) => c.category === 'dependency')!;
    expect(dep.total).toBe(1); // the attempt is still counted
    expect(dep.successRate).toBeNull(); // nothing in it reached a verdict
  });

  it('reports null rates rather than NaN when nothing has completed', () => {
    const store = new Store(':memory:');
    store.create({
      repo: 'r',
      issueNumber: 1,
      issueUrl: '',
      title: 't',
      contractId: null,
      category: null,
      severity: null,
      triggeredBy: 'test',
    });
    const a = buildAnalytics(store);
    expect(a.successRate).toBeNull();
    expect(a.cycleTimeSeconds.p50).toBeNull();
    expect(a.acu.perPr).toBeNull();
  });

  it('breaks results down by category', () => {
    const { store } = seed();
    const a = buildAnalytics(store);
    const sec = a.byCategory.find((c) => c.category === 'security')!;
    expect(sec.total).toBe(2);
    expect(sec.succeeded).toBe(1);
    expect(sec.failed).toBe(1);
    expect(sec.successRate).toBeCloseTo(0.5, 5);
  });

  it('aggregates ACU spend into a unit cost per pull request', () => {
    const { store } = seed();
    const a = buildAnalytics(store);
    expect(a.acu.total).toBe(7);
    expect(a.acu.reported).toBe(true);
    expect(a.acu.perPr).toBeCloseTo(7, 5);
  });

  /**
   * Not every plan returns ACU figures. Zero spend on work that demonstrably
   * ran means "not reported", and publishing it as a unit cost of zero would
   * be a false claim about the economics.
   */
  it('reports no unit cost when the provider returned no ACU data', () => {
    const store = new Store(':memory:');
    const r = store.create({
      repo: 'watilde/superset',
      issueNumber: 1,
      issueUrl: '',
      title: 't',
      contractId: 'SEC-001',
      category: 'security',
      severity: 'high',
      triggeredBy: 'test',
    });
    store.transition(r.id, 'succeeded', { prUrl: 'https://x/y/pull/1' });

    const a = buildAnalytics(store);
    expect(a.acu.total).toBe(0);
    expect(a.acu.reported).toBe(false);
    expect(a.acu.perPr).toBeNull();
  });

  it('groups failure reasons', () => {
    const { store } = seed();
    const a = buildAnalytics(store);
    expect(a.failureReasons[0]).toMatchObject({
      reason: 'verification commands did not pass',
      count: 1,
    });
  });

  it('records which trigger produced the work', () => {
    const { store } = seed();
    expect(buildAnalytics(store).triggers).toEqual([{ trigger: 'test', count: 4 }]);
  });

  /**
   * Opening a pull request is output; merging it is outcome. A dashboard that
   * conflates the two reports work the organisation declined as work
   * delivered, so merge rate has its own denominator: PRs opened, not
   * remediations completed.
   */
  describe('merge rate', () => {
    it('is null until a pull request exists, then measures acceptance', () => {
      const { store, ids } = seed();
      expect(buildAnalytics(store).mergeRate).toBe(0); // one PR open, none merged

      store.recordPullRequest(ids.a, { state: 'merged', mergedAt: '2026-01-01T00:00:00.000Z' });
      const a = buildAnalytics(store);
      expect(a.totals.prsMerged).toBe(1);
      expect(a.mergeRate).toBeCloseTo(1, 5);
      // Cost per merged PR is the defensible unit price; total spend includes
      // the attempts that never shipped, and that is the point.
      expect(a.acu.perMergedPr).toBeCloseTo(7, 5);
    });

    it('counts a closed-unmerged pull request against the rate', () => {
      const { store, ids } = seed();
      store.recordPullRequest(ids.a, { state: 'closed' });
      const a = buildAnalytics(store);
      expect(a.totals.prsClosed).toBe(1);
      expect(a.mergeRate).toBe(0);
    });

    it('separates agent latency from human review latency', () => {
      const { store, ids } = seed();
      store.recordPullRequest(ids.a, { state: 'merged', mergedAt: '2030-01-01T00:00:00.000Z' });

      const a = buildAnalytics(store);
      // Time-to-PR is minutes here (the test just ran); time-to-merge is years
      // away. Summing them would let slow review masquerade as a slow agent.
      expect(a.timeToPrSeconds.p50).toBeLessThan(60);
      expect(a.timeToMergeSeconds.p50).toBeGreaterThan(60);
    });
  });

  it('reports CI verdicts and self-corrections', () => {
    const { store, ids } = seed();
    store.recordCi(ids.a, 'failed', { runUrl: 'https://x/runs/1' });
    store.incrementReworks(ids.a);
    store.recordCi(ids.a, 'passed');

    const a = buildAnalytics(store);
    expect(a.ci.passed).toBe(1);
    expect(a.ci.failed).toBe(0); // superseded by the passing re-run
    expect(a.ci.reworks).toBe(1);
  });
});

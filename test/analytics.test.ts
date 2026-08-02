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
    expect(a.acu.perPr).toBeCloseTo(7, 5);
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
});

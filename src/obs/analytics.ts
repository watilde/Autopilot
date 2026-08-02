import type { Store } from '../db/index.js';

/**
 * Reporting layer.
 *
 * The brief for this module was a question: "if I were an engineering leader,
 * how would I know this is working?". Counting sessions does not answer that —
 * a system can start a hundred sessions and produce nothing. So the numbers
 * here are deliberately outcome-shaped:
 *
 *   - pull requests actually opened, not tasks attempted
 *   - success rate computed over *completed* work, so in-flight items cannot
 *     flatter it
 *   - cycle time as median and p90, because the tail is what people feel
 *   - ACU spend per merged PR, so the thing has a defensible unit cost
 *   - failure reasons, grouped, so the next improvement is obvious
 */

export interface StateCount {
  state: string;
  count: number;
}

export interface CategoryBreakdown {
  category: string;
  total: number;
  succeeded: number;
  failed: number;
  prsOpened: number;
  successRate: number | null;
}

export interface ThroughputBucket {
  day: string;
  completed: number;
  succeeded: number;
}

export interface AnalyticsSnapshot {
  generatedAt: string;
  totals: {
    total: number;
    active: number;
    completed: number;
    succeeded: number;
    failed: number;
    timedOut: number;
    prsOpened: number;
    falsePositives: number;
  };
  /** Share of completed remediations that reached a valid conclusion. */
  successRate: number | null;
  /** Share of completed remediations that produced a pull request. */
  prRate: number | null;
  cycleTimeSeconds: { p50: number | null; p90: number | null; mean: number | null };
  acu: { total: number; perPr: number | null };
  byState: StateCount[];
  byCategory: CategoryBreakdown[];
  bySeverity: StateCount[];
  throughput: ThroughputBucket[];
  failureReasons: { reason: string; count: number }[];
  triggers: { trigger: string; count: number }[];
}

const TERMINAL = `('succeeded','failed','timed_out','cancelled')`;
const ACTIVE = `('queued','dispatching','running','blocked')`;

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function buildAnalytics(store: Store): AnalyticsSnapshot {
  const totalsRow = store.query(`
    SELECT
      COUNT(*)                                                          AS total,
      SUM(CASE WHEN state IN ${ACTIVE}   THEN 1 ELSE 0 END)             AS active,
      SUM(CASE WHEN state IN ${TERMINAL} THEN 1 ELSE 0 END)             AS completed,
      SUM(CASE WHEN state = 'succeeded'  THEN 1 ELSE 0 END)             AS succeeded,
      SUM(CASE WHEN state = 'failed'     THEN 1 ELSE 0 END)             AS failed,
      SUM(CASE WHEN state = 'timed_out'  THEN 1 ELSE 0 END)             AS timed_out,
      SUM(CASE WHEN pr_url IS NOT NULL AND pr_url != '' THEN 1 ELSE 0 END) AS prs_opened,
      SUM(CASE WHEN state = 'succeeded' AND (pr_url IS NULL OR pr_url = '') THEN 1 ELSE 0 END)
                                                                        AS false_positives,
      COALESCE(SUM(acu_used), 0)                                        AS acu_total
    FROM remediations
  `)[0] ?? {};

  const total = num(totalsRow.total);
  const active = num(totalsRow.active);
  const completed = num(totalsRow.completed);
  const succeeded = num(totalsRow.succeeded);
  const failed = num(totalsRow.failed);
  const timedOut = num(totalsRow.timed_out);
  const prsOpened = num(totalsRow.prs_opened);
  const falsePositives = num(totalsRow.false_positives);
  const acuTotal = num(totalsRow.acu_total);

  // Cycle time over completed work only. Including in-flight items would make
  // the number drift down every time a new issue is labelled.
  const durations = store
    .query(
      `SELECT (julianday(completed_at) - julianday(created_at)) * 86400.0 AS secs
         FROM remediations
        WHERE completed_at IS NOT NULL AND state IN ${TERMINAL}`,
    )
    .map((r) => num(r.secs))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  const mean = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : null;

  const byState: StateCount[] = store
    .query('SELECT state, COUNT(*) AS c FROM remediations GROUP BY state ORDER BY c DESC')
    .map((r) => ({ state: String(r.state), count: num(r.c) }));

  const byCategory: CategoryBreakdown[] = store
    .query(`
      SELECT COALESCE(category, 'unknown') AS category,
             COUNT(*) AS total,
             SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN state IN ('failed','timed_out') THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN pr_url IS NOT NULL AND pr_url != '' THEN 1 ELSE 0 END) AS prs,
             SUM(CASE WHEN state IN ${TERMINAL} THEN 1 ELSE 0 END) AS completed
        FROM remediations
       GROUP BY category
       ORDER BY total DESC
    `)
    .map((r) => {
      const c = num(r.completed);
      return {
        category: String(r.category),
        total: num(r.total),
        succeeded: num(r.succeeded),
        failed: num(r.failed),
        prsOpened: num(r.prs),
        successRate: c > 0 ? num(r.succeeded) / c : null,
      };
    });

  const bySeverity: StateCount[] = store
    .query(
      `SELECT COALESCE(severity, 'unknown') AS severity, COUNT(*) AS c
         FROM remediations GROUP BY severity ORDER BY c DESC`,
    )
    .map((r) => ({ state: String(r.severity), count: num(r.c) }));

  const throughput: ThroughputBucket[] = store
    .query(`
      SELECT substr(completed_at, 1, 10) AS day,
             COUNT(*) AS completed,
             SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded
        FROM remediations
       WHERE completed_at IS NOT NULL
       GROUP BY day
       ORDER BY day DESC
       LIMIT 14
    `)
    .map((r) => ({
      day: String(r.day),
      completed: num(r.completed),
      succeeded: num(r.succeeded),
    }))
    .reverse();

  const failureReasons = store
    .query(`
      SELECT error AS reason, COUNT(*) AS c
        FROM remediations
       WHERE error IS NOT NULL AND error != ''
       GROUP BY error
       ORDER BY c DESC
       LIMIT 10
    `)
    .map((r) => ({ reason: String(r.reason), count: num(r.c) }));

  const triggers = store
    .query(
      `SELECT triggered_by AS t, COUNT(*) AS c FROM remediations GROUP BY triggered_by ORDER BY c DESC`,
    )
    .map((r) => ({ trigger: String(r.t), count: num(r.c) }));

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      total,
      active,
      completed,
      succeeded,
      failed,
      timedOut,
      prsOpened,
      falsePositives,
    },
    successRate: completed > 0 ? succeeded / completed : null,
    prRate: completed > 0 ? prsOpened / completed : null,
    cycleTimeSeconds: {
      p50: percentile(durations, 50),
      p90: percentile(durations, 90),
      mean,
    },
    acu: { total: acuTotal, perPr: prsOpened > 0 ? acuTotal / prsOpened : null },
    byState,
    byCategory,
    bySeverity,
    throughput,
    failureReasons,
    triggers,
  };
}

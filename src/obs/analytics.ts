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
 *   - merge rate, because an unmerged PR is work the organisation declined
 *   - success rate computed over work that reached a verdict, so neither
 *     in-flight items nor withdrawn ones distort it
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
    cancelled: number;
    /** succeeded + failed + timed_out: work that actually reached a verdict. */
    concluded: number;
    prsOpened: number;
    prsMerged: number;
    prsClosed: number;
    falsePositives: number;
  };
  /** Share of completed remediations that reached a valid conclusion. */
  successRate: number | null;
  /** Share of completed remediations that produced a pull request. */
  prRate: number | null;
  /** Share of opened pull requests that were merged — work actually accepted. */
  mergeRate: number | null;
  cycleTimeSeconds: { p50: number | null; p90: number | null; mean: number | null };
  /** Issue accepted to pull request open: the number an SLA would be written against. */
  timeToPrSeconds: { p50: number | null; p90: number | null };
  /** Pull request open to merged, which is human review latency, not agent latency. */
  timeToMergeSeconds: { p50: number | null };
  /** What the pull request's own CI said, and how often Devin self-corrected. */
  ci: { passed: number; failed: number; pending: number; reworks: number };
  /**
   * `reported` is false when the provider returned no ACU figures at all. That
   * is not the same as "this was free", and the difference matters when the
   * number is being used to argue a unit cost, so the rates are null rather
   * than zero in that case.
   */
  acu: { total: number; reported: boolean; perPr: number | null; perMergedPr: number | null };
  /**
   * The work the system declined to do, and the merge it asked for but never
   * recorded. Neither appears anywhere else here: a remediation that intake
   * refused never becomes a row, so the most frequent decision the orchestrator
   * makes is otherwise invisible — and a system that only reports what it did
   * is not observable, it is advertising.
   */
  refusals: {
    /** Intake declined the issue: already in flight, already fixed, already merged. */
    deduplicated: number;
    /** Merges asked for. Asking is not merging, and the agent can decline. */
    mergeRequested: number;
    /** Requested merges that never happened and were handed to a human. */
    mergeEscalated: number;
  };
  byState: StateCount[];
  byCategory: CategoryBreakdown[];
  bySeverity: StateCount[];
  throughput: ThroughputBucket[];
  failureReasons: { reason: string; count: number }[];
  triggers: { trigger: string; count: number }[];
}

const TERMINAL = `('succeeded','failed','timed_out','cancelled')`;
/** Work that reached a verdict. TERMINAL minus withdrawals — see `concluded`. */
const CONCLUDED = `('succeeded','failed','timed_out')`;
/** The states that represent a loss. A withdrawal is not one of them. */
const FAILED = `('failed','timed_out')`;
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
      SUM(CASE WHEN state = 'cancelled'  THEN 1 ELSE 0 END)             AS cancelled,
      SUM(CASE WHEN pr_url IS NOT NULL AND pr_url != '' THEN 1 ELSE 0 END) AS prs_opened,
      SUM(CASE WHEN pr_state = 'merged'  THEN 1 ELSE 0 END)              AS prs_merged,
      SUM(CASE WHEN pr_state = 'closed'  THEN 1 ELSE 0 END)              AS prs_closed,
      SUM(CASE WHEN ci_status = 'passed' THEN 1 ELSE 0 END)              AS ci_passed,
      SUM(CASE WHEN ci_status = 'failed' THEN 1 ELSE 0 END)              AS ci_failed,
      SUM(CASE WHEN ci_status = 'pending' THEN 1 ELSE 0 END)             AS ci_pending,
      COALESCE(SUM(reworks), 0)                                         AS reworks,
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
  const cancelled = num(totalsRow.cancelled);
  /**
   * Success is measured over work that reached a verdict, not over everything
   * that stopped. A remediation an operator cancelled — budget, a duplicate, a
   * change of plan — was withdrawn before the agent could be right or wrong
   * about it, so counting it as a non-success measures our decisions rather
   * than the system's output. Cancellations stay visible in `totals.cancelled`
   * and in the state breakdown; they are excluded from this denominator only.
   */
  const concluded = succeeded + failed + timedOut;
  const prsOpened = num(totalsRow.prs_opened);
  const prsMerged = num(totalsRow.prs_merged);
  const prsClosed = num(totalsRow.prs_closed);
  const falsePositives = num(totalsRow.false_positives);
  const acuTotal = num(totalsRow.acu_total);

  // Cycle time over work that reached a verdict. Including in-flight items
  // would make the number drift down every time a new issue is labelled, and
  // including cancellations would do it too: a duplicate stopped ten seconds
  // after it was queued is a very fast nothing, and averaging it in makes the
  // system look quicker than it is.
  const durations = store
    .query(
      `SELECT (julianday(completed_at) - julianday(created_at)) * 86400.0 AS secs
         FROM remediations
        WHERE completed_at IS NOT NULL AND state IN ${CONCLUDED}`,
    )
    .map((r) => num(r.secs))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);

  const mean = durations.length
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : null;

  // Two intervals, deliberately separate. Issue → PR is what the agent
  // controls; PR → merged is human review latency. Reporting only the sum
  // would let a slow review make the automation look slow, and a fast review
  // hide a slow agent.
  const elapsed = (from: string, to: string, where: string) =>
    store
      .query(
        `SELECT (julianday(${to}) - julianday(${from})) * 86400.0 AS secs
           FROM remediations WHERE ${where}`,
      )
      .map((r) => num(r.secs))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .sort((a, b) => a - b);

  const toPr = elapsed('created_at', 'pr_opened_at', "pr_opened_at IS NOT NULL");
  const toMerge = elapsed('pr_opened_at', 'pr_merged_at', "pr_merged_at IS NOT NULL AND pr_opened_at IS NOT NULL");

  const byState: StateCount[] = store
    .query('SELECT state, COUNT(*) AS c FROM remediations GROUP BY state ORDER BY c DESC')
    .map((r) => ({ state: String(r.state), count: num(r.c) }));

  const byCategory: CategoryBreakdown[] = store
    .query(`
      SELECT COALESCE(category, 'unknown') AS category,
             COUNT(*) AS total,
             SUM(CASE WHEN state = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
             SUM(CASE WHEN state IN ${FAILED} THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN pr_url IS NOT NULL AND pr_url != '' THEN 1 ELSE 0 END) AS prs,
             -- Same denominator as the headline rate: work that reached a
             -- verdict. Cancellations are withdrawals, not losses.
             SUM(CASE WHEN state IN ${CONCLUDED} THEN 1 ELSE 0 END) AS concluded
        FROM remediations
       GROUP BY category
       ORDER BY total DESC
    `)
    .map((r) => {
      const c = num(r.concluded);
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
         AND state IN ${CONCLUDED}
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

  // Only states that represent a loss. An operator's reason for cancelling —
  // "paused for budget", "duplicate" — is not a failure mode, and listing it
  // under "why things failed" sends whoever reads this chart after the wrong
  // problem.
  const failureReasons = store
    .query(`
      SELECT error AS reason, COUNT(*) AS c
        FROM remediations
       WHERE error IS NOT NULL AND error != ''
         AND state IN ${FAILED}
       GROUP BY error
       ORDER BY c DESC
       LIMIT 10
    `)
    .map((r) => ({ reason: String(r.reason), count: num(r.c) }));

  // Refusals live in two places because they are two different decisions: an
  // intake refusal is an event (there is no remediation to hang it on — that is
  // the point), a merge escalation is a stamp on the row it concerns.
  const deduplicated = num(
    store.query(`SELECT COUNT(*) AS c FROM events WHERE type = 'intake.deduplicated'`)[0]?.c,
  );
  const mergeRow =
    store.query(`
      SELECT SUM(CASE WHEN merge_requested_at IS NOT NULL THEN 1 ELSE 0 END) AS requested,
             SUM(CASE WHEN merge_escalated_at IS NOT NULL THEN 1 ELSE 0 END) AS escalated
        FROM remediations
    `)[0] ?? {};

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
      cancelled,
      concluded,
      prsOpened,
      prsMerged,
      prsClosed,
      falsePositives,
    },
    successRate: concluded > 0 ? succeeded / concluded : null,
    prRate: concluded > 0 ? prsOpened / concluded : null,
    mergeRate: prsOpened > 0 ? prsMerged / prsOpened : null,
    cycleTimeSeconds: {
      p50: percentile(durations, 50),
      p90: percentile(durations, 90),
      mean,
    },
    timeToPrSeconds: { p50: percentile(toPr, 50), p90: percentile(toPr, 90) },
    timeToMergeSeconds: { p50: percentile(toMerge, 50) },
    ci: {
      passed: num(totalsRow.ci_passed),
      failed: num(totalsRow.ci_failed),
      pending: num(totalsRow.ci_pending),
      reworks: num(totalsRow.reworks),
    },
    acu: {
      total: acuTotal,
      reported: acuTotal > 0,
      perPr: acuTotal > 0 && prsOpened > 0 ? acuTotal / prsOpened : null,
      perMergedPr: acuTotal > 0 && prsMerged > 0 ? acuTotal / prsMerged : null,
    },
    refusals: {
      deduplicated,
      mergeRequested: num(mergeRow.requested),
      mergeEscalated: num(mergeRow.escalated),
    },
    byState,
    byCategory,
    bySeverity,
    throughput,
    failureReasons,
    triggers,
  };
}

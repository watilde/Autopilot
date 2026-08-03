import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus surface.
 *
 * These are the counters an on-call engineer would page on, kept deliberately
 * few: is work arriving, is it finishing, how long is it taking, and what is
 * it costing. Richer historical analysis lives in the SQLite event log and is
 * served by /api/analytics — metrics here are for alerting, not for reports.
 */

export const registry = new Registry();
registry.setDefaultLabels({ service: 'autopilot' });
collectDefaultMetrics({ register: registry });

export const webhookDeliveries = new Counter({
  name: 'autopilot_webhook_deliveries_total',
  help: 'Webhook deliveries received, by event and disposition',
  labelNames: ['event', 'action', 'result'] as const,
  registers: [registry],
});

export const dispatches = new Counter({
  name: 'autopilot_dispatches_total',
  help: 'Attempts to hand an issue to Devin',
  labelNames: ['result', 'category'] as const,
  registers: [registry],
});

export const remediationsCompleted = new Counter({
  name: 'autopilot_remediations_completed_total',
  help: 'Remediations that reached a terminal state',
  labelNames: ['outcome', 'category', 'severity'] as const,
  registers: [registry],
});

export const activeRemediations = new Gauge({
  name: 'autopilot_remediations_active',
  help: 'Remediations currently queued, dispatching, running or blocked',
  registers: [registry],
});

/**
 * Cycle time is the number an engineering leader actually cares about: how
 * long from "issue labelled" to "PR on the board". Bucketed generously
 * because real agent sessions run in minutes, not milliseconds.
 */
export const cycleTime = new Histogram({
  name: 'autopilot_remediation_cycle_seconds',
  help: 'Seconds from remediation created to terminal state',
  labelNames: ['outcome', 'category'] as const,
  buckets: [30, 60, 120, 300, 600, 900, 1800, 3600, 7200],
  registers: [registry],
});

/**
 * Merged is the only outcome that means the fix shipped. Kept separate from
 * `remediationsCompleted` so an alert can distinguish "the agent is producing
 * work" from "the work is being accepted" — those degrade independently.
 */
export const pullRequests = new Counter({
  name: 'autopilot_pull_requests_total',
  help: 'Pull requests by final disposition',
  labelNames: ['state', 'category'] as const,
  registers: [registry],
});

export const ciResults = new Counter({
  name: 'autopilot_ci_results_total',
  help: "Verdicts from the pull request's own CI",
  labelNames: ['status', 'category'] as const,
  registers: [registry],
});

/** Self-corrections triggered by a CI failure, and how they ended. */
export const reworks = new Counter({
  name: 'autopilot_reworks_total',
  help: 'CI failures sent back to a Devin session, by disposition',
  labelNames: ['result', 'category'] as const,
  registers: [registry],
});

/**
 * Auto-merge attempts by disposition. Counted where Autopilot acts, never where
 * a merge lands — `autopilot_pull_requests_total{state="merged"}` is the one
 * that says the change actually shipped, and the gap between `requested` here
 * and that one is exactly the thing worth alerting on.
 *
 * `escalated` is that gap made explicit: asked, never performed, handed to a
 * human. A deployment where it dominates `requested` has an auto-merge policy
 * that does not work, which is worth knowing before it is worth debugging.
 */
export const autoMerges = new Counter({
  name: 'autopilot_auto_merges_total',
  help: 'Auto-merge attempts by disposition: requested from a session, or escalated to a human',
  labelNames: ['result', 'category'] as const,
  registers: [registry],
});

export const devinApiErrors = new Counter({
  name: 'autopilot_devin_api_errors_total',
  help: 'Errors returned by the Devin API',
  labelNames: ['operation', 'status'] as const,
  registers: [registry],
});

export const acuConsumed = new Counter({
  name: 'autopilot_acu_consumed_total',
  help: 'ACUs reported by completed Devin sessions',
  labelNames: ['category'] as const,
  registers: [registry],
});

export const reconcilerRuns = new Counter({
  name: 'autopilot_reconciler_runs_total',
  help: 'Reconciliation passes, by result',
  labelNames: ['result'] as const,
  registers: [registry],
});

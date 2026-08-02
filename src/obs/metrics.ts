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

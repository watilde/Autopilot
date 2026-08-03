import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Store } from '../db/index.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { Scanner } from '../core/scanner.js';
import type { AuditRunner } from '../core/audit.js';
import type { DevinClient } from '../devin/types.js';
import { supportsPlatformApi } from '../devin/types.js';
import type { GitHubClient } from '../github/client.js';
import { buildAnalytics } from '../obs/analytics.js';
import { registry } from '../obs/metrics.js';

/**
 * Machine-readable surface. The dashboard is a client of these endpoints, not
 * a special case — anything the UI can show, a script or a Grafana panel can
 * pull too.
 */
export function registerApiRoutes(
  app: FastifyInstance,
  store: Store,
  orchestrator: Orchestrator,
  scanner: Scanner,
  github: GitHubClient,
  devin: DevinClient,
  audit?: AuditRunner,
): void {
  app.get('/healthz', async () => ({
    status: 'ok',
    mode: config.DEVIN_MODE,
    repo: `${config.GITHUB_OWNER}/${config.GITHUB_REPO}`,
    activeRemediations: store.countActive(),
    githubConfigured: github.enabled,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  app.get('/api/analytics', async () => buildAnalytics(store));

  /**
   * The same sessions, counted by Devin instead of by us.
   *
   * Autopilot already records session ids, ACUs and pull requests, so this is
   * not new information — it is *independent* information. If the tags and
   * prompts we claim to have sent are not the ones Devin received, this is
   * where that shows up, and a reviewer can check it against the Devin
   * dashboard without taking our word for anything.
   */
  app.get('/api/devin/insights', async (_req, reply) => {
    if (!supportsPlatformApi(devin)) {
      return reply.code(501).send({
        error: `session insights need the v3 API; this client is ${devin.apiVersion} in ${devin.mode} mode`,
        sessions: [],
      });
    }
    try {
      return { sessions: await devin.listSessionInsights(50) };
    } catch (err) {
      // Reporting must never take the dashboard down with it.
      return reply.code(502).send({ error: (err as Error).message, sessions: [] });
    }
  });

  app.get('/api/remediations', async (req) => {
    const { state, limit } = req.query as { state?: string; limit?: string };
    const all = store.listAll(Number(limit) || 200);
    return { remediations: state ? all.filter((r) => r.state === state) : all };
  });

  app.get('/api/remediations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = store.get(Number(id));
    if (!r) return reply.code(404).send({ error: 'not found' });
    return r;
  });

  app.get('/api/events', async (req) => {
    const { limit, type } = req.query as { limit?: string; type?: string };
    return { events: store.listEvents(Number(limit) || 100, type) };
  });

  /**
   * Manual trigger. Useful for demos and for re-running a remediation after a
   * transient failure without waiting for a scan.
   */
  app.post('/api/trigger', async (req, reply) => {
    const { issueNumber } = (req.body ?? {}) as { issueNumber?: number };
    if (!issueNumber) return reply.code(400).send({ error: 'issueNumber is required' });

    const issue = await github.getIssue(issueNumber);
    if (!issue) {
      return reply.code(404).send({ error: `issue #${issueNumber} not found or GitHub not configured` });
    }

    const result = await orchestrator.intake(issue, 'manual-api');
    if (result.accepted) void orchestrator.tick();
    return reply.code(202).send({
      accepted: result.accepted,
      reason: result.reason,
      remediationId: result.remediation?.id ?? null,
    });
  });

  /**
   * Stop one remediation without stopping the service. Needed because the
   * label-removal path only fires when a GitHub webhook is actually wired up.
   */
  app.post('/api/remediations/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = (req.body ?? {}) as { reason?: string };
    const r = await orchestrator.cancel(Number(id), reason ?? 'cancelled by operator');
    if (!r) return reply.code(404).send({ error: 'not found' });
    return { id: r.id, issueNumber: r.issueNumber, state: r.state, error: r.error };
  });

  /**
   * Answer a blocked session. `blocked` is the only non-terminal state the
   * system cannot exit on its own, so this is the path back.
   */
  app.post('/api/remediations/:id/reply', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { message } = (req.body ?? {}) as { message?: string };
    if (!message?.trim()) return reply.code(400).send({ error: 'message is required' });

    const r = await orchestrator.reply(Number(id), message);
    if (!r) return reply.code(404).send({ error: 'not found, or has no Devin session' });
    void orchestrator.tick();
    return { id: r.id, issueNumber: r.issueNumber, state: r.state };
  });

  /**
   * Find work, rather than waiting to be given it.
   *
   * Every other trigger in this system starts at "an issue exists". This one
   * starts before that: a Devin session reads the repository, decides what is
   * worth fixing, and files contract-carrying issues, which arrive back through
   * the ordinary webhook path. Intake still refuses anything without a valid
   * contract, so an audit that files rubbish produces refusals, not sessions.
   *
   * Not gated behind a flag, because it costs one session and files at most
   * three issues, and every one of them still has to survive intake. It is
   * gated to one at a time, because two audits reading the same repository
   * would file the same defects twice.
   */
  app.post('/api/audit', async (_req, reply) => {
    if (!audit) return reply.code(501).send({ error: 'no audit runner configured' });
    const result = await audit.dispatch('manual-api');
    return reply.code(result.dispatched ? 202 : 409).send(result);
  });

  app.get('/api/audit', async () => {
    if (!audit) return { inFlight: [] };
    return { inFlight: audit.inFlight() };
  });

  app.post('/api/scan', async () => {
    const result = await scanner.scan();
    void orchestrator.tick();
    return result;
  });

  /** Force a reconcile pass; handy when watching a live demo. */
  app.post('/api/tick', async () => {
    await orchestrator.tick();
    // Audits are polled on the same beat. They are not remediations and have no
    // row, but a finished audit that nobody closed out blocks the next one.
    const auditsSettled = audit ? await audit.reconcile() : 0;
    return { ok: true, active: store.countActive(), auditsSettled };
  });
}

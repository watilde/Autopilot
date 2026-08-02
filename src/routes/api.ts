import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import type { Store } from '../db/index.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { Scanner } from '../core/scanner.js';
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
    const { limit } = req.query as { limit?: string };
    return { events: store.listEvents(Number(limit) || 100) };
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

  app.post('/api/scan', async () => {
    const result = await scanner.scan();
    void orchestrator.tick();
    return result;
  });

  /** Force a reconcile pass; handy when watching a live demo. */
  app.post('/api/tick', async () => {
    await orchestrator.tick();
    return { ok: true, active: store.countActive() };
  });
}

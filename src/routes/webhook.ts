import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Store } from '../db/index.js';
import type { Orchestrator } from '../core/orchestrator.js';
import { verifySignature } from '../github/webhook.js';
import type { IssueRef } from '../github/client.js';
import { logger } from '../logger.js';
import * as metrics from '../obs/metrics.js';

interface WithRawBody extends FastifyRequest {
  rawBody?: Buffer;
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels?: Array<{ name?: string } | string>;
}

interface GhPullRequest {
  number: number;
  html_url: string;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  head?: { ref?: string };
}

interface GhPayload {
  action?: string;
  issue?: GhIssue;
  label?: { name?: string };
  comment?: { body?: string; user?: { login?: string } };
  repository?: { full_name?: string };
  pull_request?: GhPullRequest;
  workflow_run?: {
    id: number;
    name?: string;
    head_branch?: string | null;
    conclusion?: string | null;
    status?: string;
    html_url?: string;
    pull_requests?: Array<{ number: number }>;
  };
}

function toIssueRef(i: GhIssue): IssueRef {
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? null,
    htmlUrl: i.html_url,
    state: i.state,
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
  };
}

/**
 * The event ingress.
 *
 * Three properties matter more than the routing here: the payload is
 * authenticated before it is parsed for meaning, the delivery ID makes retries
 * idempotent, and the handler returns 202 as soon as the work is *recorded*
 * rather than when it is finished. GitHub times webhook deliveries out after
 * ten seconds; a Devin session takes minutes. Accepting fast and reconciling
 * later is the only shape that works.
 */
export function registerWebhookRoutes(
  app: FastifyInstance,
  store: Store,
  orchestrator: Orchestrator,
): void {
  app.post('/webhooks/github', async (request: WithRawBody, reply) => {
    const event = String(request.headers['x-github-event'] ?? '');
    const deliveryId = String(request.headers['x-github-delivery'] ?? '');
    const signature = request.headers['x-hub-signature-256'] as string | undefined;

    if (config.GITHUB_WEBHOOK_SECRET) {
      const raw = request.rawBody ?? Buffer.from(JSON.stringify(request.body ?? {}), 'utf8');
      const result = verifySignature(raw, signature, config.GITHUB_WEBHOOK_SECRET);
      if (!result.ok) {
        metrics.webhookDeliveries.inc({ event, action: 'n/a', result: 'unauthorized' });
        logger.warn({ event, deliveryId, reason: result.reason }, 'rejected webhook');
        return reply.code(401).send({ error: 'invalid signature', reason: result.reason });
      }
    } else if (!config.ALLOW_UNSIGNED_WEBHOOKS) {
      return reply.code(401).send({ error: 'webhook secret not configured' });
    }

    const payload = (request.body ?? {}) as GhPayload;
    const action = payload.action ?? '';

    if (event === 'ping') {
      metrics.webhookDeliveries.inc({ event, action, result: 'ok' });
      return reply.code(200).send({ ok: true, message: 'autopilot is listening' });
    }

    // GitHub retries on any non-2xx and on timeouts. Without this guard a
    // retry would create a second Devin session for the same issue.
    if (deliveryId && !store.recordDelivery(deliveryId, event, action)) {
      metrics.webhookDeliveries.inc({ event, action, result: 'duplicate' });
      return reply.code(200).send({ ok: true, deduplicated: true });
    }

    // --- workflow_run: the review-fix loop ------------------------------------
    // CI is the one judgement in this system that Autopilot does not make. When
    // it fails on a branch we opened, the failure goes back to the session that
    // produced it rather than to a human's queue.
    if (event === 'workflow_run') {
      const run = payload.workflow_run;
      const branch = run?.head_branch ?? '';
      if (!run || action !== 'completed' || !branch.startsWith('autopilot/')) {
        metrics.webhookDeliveries.inc({ event, action, result: 'ignored' });
        return reply.code(202).send({ ok: true, ignored: 'not a completed autopilot run' });
      }

      const result = await orchestrator.handleCiResult({
        branch,
        conclusion: run.conclusion ?? 'unknown',
        runId: run.id,
        runUrl: run.html_url ?? null,
      });
      metrics.webhookDeliveries.inc({
        event,
        action,
        result: result.handled ? 'accepted' : 'skipped',
      });
      return reply.code(202).send({ ok: true, ...result });
    }

    // --- pull_request: merge outcomes -----------------------------------------
    if (event === 'pull_request') {
      const pr = payload.pull_request;
      const branch = pr?.head?.ref ?? '';
      if (!pr || !branch.startsWith('autopilot/')) {
        metrics.webhookDeliveries.inc({ event, action, result: 'ignored' });
        return reply.code(202).send({ ok: true, ignored: 'not an autopilot pull request' });
      }

      const state = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
      const updated = orchestrator.recordPullRequestEvent({
        url: pr.html_url,
        state,
        mergedAt: pr.merged_at ?? null,
        branch,
      });
      metrics.webhookDeliveries.inc({ event, action, result: updated ? 'accepted' : 'skipped' });
      return reply.code(202).send({ ok: true, prState: state, remediationId: updated?.id ?? null });
    }

    if (event !== 'issues' && event !== 'issue_comment') {
      metrics.webhookDeliveries.inc({ event, action, result: 'ignored' });
      return reply.code(202).send({ ok: true, ignored: `event ${event} not handled` });
    }

    const issue = payload.issue;
    if (!issue) {
      metrics.webhookDeliveries.inc({ event, action, result: 'ignored' });
      return reply.code(202).send({ ok: true, ignored: 'no issue in payload' });
    }

    // --- issue_comment: operator commands -----------------------------------
    if (event === 'issue_comment' && action === 'created') {
      const body = (payload.comment?.body ?? '').trim();
      if (/^\/autopilot\s+retry\b/i.test(body)) {
        const ref = toIssueRef(issue);
        const result = await orchestrator.intake(ref, `comment:${payload.comment?.user?.login ?? '?'}`);
        metrics.webhookDeliveries.inc({ event, action, result: result.accepted ? 'accepted' : 'skipped' });
        return reply.code(202).send({ ok: true, command: 'retry', ...result });
      }
      metrics.webhookDeliveries.inc({ event, action, result: 'ignored' });
      return reply.code(202).send({ ok: true, ignored: 'comment is not an autopilot command' });
    }

    // --- issues: label-driven intake ----------------------------------------
    const ref = toIssueRef(issue);

    if (action === 'unlabeled' && payload.label?.name === config.AUTOPILOT_LABEL) {
      const active = store.findActiveByIssue(
        `${config.GITHUB_OWNER}/${config.GITHUB_REPO}`,
        issue.number,
      );
      if (active) {
        store.transition(active.id, 'cancelled', { error: 'autopilot label removed' });
        logger.info({ issue: issue.number }, 'remediation cancelled by label removal');
      }
      metrics.webhookDeliveries.inc({ event, action, result: 'cancelled' });
      return reply.code(202).send({ ok: true, cancelled: Boolean(active) });
    }

    if (action !== 'labeled' && action !== 'opened' && action !== 'reopened') {
      metrics.webhookDeliveries.inc({ event, action, result: 'ignored' });
      return reply.code(202).send({ ok: true, ignored: `action ${action} not handled` });
    }

    const result = await orchestrator.intake(ref, `webhook:${event}.${action}`);
    metrics.webhookDeliveries.inc({
      event,
      action,
      result: result.accepted ? 'accepted' : 'skipped',
    });

    // Nudge the loop so a demo does not wait a full interval for the first
    // dispatch. Deliberately not awaited: the response must not block on it.
    if (result.accepted) void orchestrator.tick();

    return reply.code(202).send({
      ok: true,
      accepted: result.accepted,
      reason: result.reason,
      remediationId: result.remediation?.id ?? null,
    });
  });
}

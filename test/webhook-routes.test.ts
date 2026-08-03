import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { signPayload } from '../src/github/webhook.js';
import type { Store } from '../src/db/index.js';
import type { Orchestrator } from '../src/core/orchestrator.js';

/**
 * The ingress, exercised end to end.
 *
 * The unit tests cover the HMAC maths; these cover the wiring around it — that
 * an unsigned delivery cannot reach the orchestrator, that a retry is
 * swallowed, and that a CI result on one of our branches actually lands in the
 * review-fix loop rather than being counted and dropped.
 *
 * The secret is set before the config module is imported, because config is
 * parsed once at boot by design: a server that re-reads its own settings
 * mid-flight is a server whose behaviour cannot be reasoned about.
 */

const SECRET = 'route-test-secret';

let app: FastifyInstance;
let store: Store;
let orchestrator: Orchestrator;

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.DEVIN_MODE = 'mock';
  process.env.DATABASE_PATH = ':memory:';

  const { buildServer } = await import('../src/server.js');
  ({ app, store, orchestrator } = buildServer());
  await app.ready();
});

let delivery = 0;
function post(event: string, payload: unknown, opts: { sign?: boolean } = {}) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': `delivery-${++delivery}`,
      ...(opts.sign === false ? {} : { 'x-hub-signature-256': signPayload(body, SECRET) }),
    },
    payload: body,
  });
}

describe('webhook ingress', () => {
  it('refuses an unsigned delivery', async () => {
    const res = await post('ping', {}, { sign: false });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a signed ping', async () => {
    const res = await post('ping', {});
    expect(res.statusCode).toBe(200);
  });

  it('swallows a redelivery of the same delivery id', async () => {
    const body = JSON.stringify({ action: 'completed' });
    const headers = {
      'content-type': 'application/json',
      'x-github-event': 'workflow_run',
      'x-github-delivery': 'repeated-uuid',
      'x-hub-signature-256': signPayload(body, SECRET),
    };
    const first = await app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: body });
    const second = await app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: body });

    expect(first.json()).not.toMatchObject({ deduplicated: true });
    expect(second.json()).toMatchObject({ deduplicated: true });
  });
});

describe('workflow_run routing', () => {
  it('ignores a run on a branch Autopilot does not own', async () => {
    const res = await post('workflow_run', {
      action: 'completed',
      workflow_run: { id: 1, head_branch: 'master', conclusion: 'failure' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ignored: expect.stringContaining('autopilot') });
  });

  it('ignores a run that has not finished', async () => {
    const res = await post('workflow_run', {
      action: 'requested',
      workflow_run: { id: 2, head_branch: 'autopilot/sec-001-issue-1', conclusion: null },
    });
    expect(res.json()).toMatchObject({ ignored: expect.stringContaining('completed') });
  });

  it('routes a completed run on an autopilot branch into the loop', async () => {
    const res = await post('workflow_run', {
      action: 'completed',
      workflow_run: {
        id: 3,
        head_branch: 'autopilot/sec-001-issue-4242',
        conclusion: 'failure',
        html_url: 'https://github.com/watilde/superset/actions/runs/3',
      },
    });

    // No remediation exists for issue 4242, so the loop declines it — but it
    // reached the loop, which is what this test is about.
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ handled: false, reason: expect.stringMatching(/no remediation/) });
  });
});

describe('pull_request_review routing', () => {
  const pr = {
    number: 7,
    html_url: 'https://github.com/watilde/superset/pull/7',
    state: 'open',
    head: { ref: 'autopilot/sec-001-issue-4242' },
  };

  it('ignores a review on a branch Autopilot does not own', async () => {
    const res = await post('pull_request_review', {
      action: 'submitted',
      review: { state: 'changes_requested', body: 'no' },
      pull_request: { ...pr, head: { ref: 'feature/someone-else' } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ignored: expect.stringContaining('autopilot') });
  });

  /**
   * A review is edited and dismissed as well as submitted. Only the submission
   * is a verdict; the others would re-send work that was already sent.
   */
  it('ignores a review that was edited rather than submitted', async () => {
    const res = await post('pull_request_review', {
      action: 'edited',
      review: { state: 'changes_requested', body: 'no' },
      pull_request: pr,
    });
    expect(res.json()).toMatchObject({ ignored: expect.stringContaining('submitted') });
  });

  it('routes a submitted review on an autopilot branch into the loop', async () => {
    const res = await post('pull_request_review', {
      action: 'submitted',
      review: {
        state: 'changes_requested',
        body: 'use the existing helper',
        html_url: 'https://github.com/watilde/superset/pull/7#pullrequestreview-1',
        user: { login: 'a-human' },
      },
      pull_request: pr,
    });

    // No remediation exists for issue 4242, so the loop declines it — but it
    // reached the loop, which is what this test is about.
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ handled: false, reason: expect.stringMatching(/no remediation/) });
  });
});

describe('pull_request routing', () => {
  it('records a merge against the remediation that opened it', async () => {
    const { SEED_ISSUES } = await import('../scripts/issues.js');
    const intake = await orchestrator.intake(
      {
        number: 77,
        title: 'Unsafe YAML deserialization',
        body: SEED_ISSUES[0]!.body,
        htmlUrl: 'https://github.com/watilde/superset/issues/77',
        state: 'open',
        labels: ['autopilot'],
      },
      'test',
    );
    const id = intake.remediation!.id;
    const prUrl = 'https://github.com/watilde/superset/pull/77';
    store.transition(id, 'succeeded', { prUrl });

    const res = await post('pull_request', {
      action: 'closed',
      pull_request: {
        number: 77,
        html_url: prUrl,
        state: 'closed',
        merged: true,
        merged_at: '2026-02-02T00:00:00.000Z',
        head: { ref: 'autopilot/sec-001-issue-77' },
      },
    });

    expect(res.json()).toMatchObject({ prState: 'merged', remediationId: id });
    expect(store.get(id)!.prMergedAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('ignores a pull request from someone else', async () => {
    const res = await post('pull_request', {
      action: 'closed',
      pull_request: {
        number: 999,
        html_url: 'https://github.com/watilde/superset/pull/999',
        state: 'closed',
        merged: true,
        head: { ref: 'dependabot/pip/urllib3' },
      },
    });
    expect(res.json()).toMatchObject({ ignored: expect.stringContaining('autopilot') });
  });
});

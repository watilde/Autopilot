import { describe, expect, it } from 'vitest';
import { normalizeV1 } from '../src/devin/client-v1.js';
import { normalizeV3 } from '../src/devin/client-v3.js';
import { inferApiVersion } from '../src/devin/types.js';

/**
 * The normalisers are the seam between two incompatible API generations and
 * the orchestrator's single state machine. If they disagree about what
 * "finished" means, the success metric silently becomes wrong — so the
 * mapping is pinned here rather than trusted.
 */

describe('credential → API version inference', () => {
  it('routes cog_ service-user credentials to v3', () => {
    expect(inferApiVersion('cog_te26abc')).toBe('v3');
  });

  it('routes legacy apk_ keys to v1', () => {
    expect(inferApiVersion('apk_user_abc')).toBe('v1');
    expect(inferApiVersion('apk_abc')).toBe('v1');
  });
});

describe('v1 normalisation', () => {
  const base = { session_id: 's1' };

  it('maps finished to finished and lifts the pull request url', () => {
    const n = normalizeV1({
      ...base,
      status_enum: 'finished',
      pull_request: { url: 'https://github.com/o/r/pull/7' },
      structured_output: { status: 'fixed' },
    });
    expect(n.state).toBe('finished');
    expect(n.pullRequestUrl).toBe('https://github.com/o/r/pull/7');
    expect(n.structuredOutput).toEqual({ status: 'fixed' });
  });

  it('maps expired to failed', () => {
    expect(normalizeV1({ ...base, status_enum: 'expired' }).state).toBe('failed');
  });

  it('maps blocked to blocked', () => {
    expect(normalizeV1({ ...base, status_enum: 'blocked' }).state).toBe('blocked');
  });

  it.each(['working', 'resumed', 'suspend_requested', 'resume_requested'])(
    'treats %s as running',
    (status) => {
      expect(normalizeV1({ ...base, status_enum: status }).state).toBe('running');
    },
  );

  it('takes the last non-empty message', () => {
    const n = normalizeV1({
      ...base,
      status_enum: 'blocked',
      messages: [{ message: 'first' }, { message: '  ' }, { message: 'which behaviour?' }],
    });
    expect(n.lastMessage).toBe('which behaviour?');
  });

  it('reports a missing cost as null rather than zero', () => {
    // Zero would be a real, misleading value in the ACU-per-PR calculation.
    expect(normalizeV1({ ...base, status_enum: 'working' }).acuUsed).toBeNull();
  });
});

describe('v3 normalisation', () => {
  const base = { session_id: 's3' };

  it.each(['new', 'claimed', 'running', 'resuming'])('treats %s as running', (status) => {
    expect(normalizeV3({ ...base, status }).state).toBe('running');
  });

  it('maps exit/finished to finished', () => {
    expect(normalizeV3({ ...base, status: 'exit', status_detail: 'finished' }).state).toBe(
      'finished',
    );
  });

  it('maps a hard error status to failed', () => {
    expect(normalizeV3({ ...base, status: 'error' }).state).toBe('failed');
  });

  // Billing and quota stops are failures no matter what else the session did.
  it.each([
    'error',
    'usage_limit_exceeded',
    'out_of_credits',
    'out_of_quota',
    'payment_declined',
    'org_usage_limit_exceeded',
  ])('maps terminal detail %s to failed', (status_detail) => {
    expect(normalizeV3({ ...base, status: 'exit', status_detail }).state).toBe('failed');
  });

  it.each(['waiting_for_user', 'waiting_for_approval'])(
    'maps %s to blocked',
    (status_detail) => {
      expect(normalizeV3({ ...base, status: 'running', status_detail }).state).toBe('blocked');
    },
  );

  it('treats suspended as blocked, since it will not progress alone', () => {
    expect(normalizeV3({ ...base, status: 'suspended' }).state).toBe('blocked');
  });

  /**
   * `inactivity` and `user_request` still count as finished: the session may
   * have opened a PR before stopping, and judge() decides on the evidence.
   */
  it.each(['inactivity', 'user_request'])('treats exit/%s as finished', (status_detail) => {
    expect(normalizeV3({ ...base, status: 'exit', status_detail }).state).toBe('finished');
  });

  it('takes the first populated pull request from the array', () => {
    const n = normalizeV3({
      ...base,
      status: 'exit',
      status_detail: 'finished',
      pull_requests: [
        { pr_url: '', pr_state: null },
        { pr_url: 'https://github.com/o/r/pull/12', pr_state: 'open' },
      ],
    });
    expect(n.pullRequestUrl).toBe('https://github.com/o/r/pull/12');
  });

  it('reports no pull request as null, not undefined', () => {
    expect(normalizeV3({ ...base, status: 'exit', pull_requests: [] }).pullRequestUrl).toBeNull();
  });

  it('carries acus_consumed through as the cost signal', () => {
    expect(normalizeV3({ ...base, status: 'running', acus_consumed: 3.5 }).acuUsed).toBe(3.5);
  });

  it('preserves the composite provider status for triage', () => {
    expect(normalizeV3({ ...base, status: 'exit', status_detail: 'finished' }).rawStatus).toBe(
      'exit/finished',
    );
  });
});

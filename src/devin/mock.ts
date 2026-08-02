import type {
  CreateSessionInput,
  CreateSessionResponse,
  DevinClient,
  SessionDetail,
} from './types.js';

/**
 * A deterministic, in-process stand-in for Devin.
 *
 * This exists so the whole pipeline — webhook, dispatch, reconcile, report —
 * can be exercised in CI and in a reviewer's terminal without an API key and
 * without spending ACUs. It is not a toy: it reproduces the states the
 * orchestrator actually has to handle, including the awkward ones (blocked,
 * expired, a session that finishes without opening a PR).
 *
 * Outcomes are derived from a hash of the session tags, so the same issue
 * always produces the same result and demos are repeatable.
 */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

type Outcome = 'fixed' | 'blocked' | 'expired' | 'finished_no_pr';

interface MockSession {
  id: string;
  input: CreateSessionInput;
  polls: number;
  createdAt: string;
  outcome: Outcome;
  pollsUntilTerminal: number;
}

export interface MockOptions {
  /** Polls spent in `working` before reaching a terminal state. */
  pollsUntilTerminal?: number;
  /** Force every session to one outcome (used by tests). */
  forceOutcome?: Outcome;
}

export class DevinMockClient implements DevinClient {
  readonly mode = 'mock' as const;
  private sessions = new Map<string, MockSession>();
  private counter = 0;
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResponse> {
    const seed = (input.tags ?? []).join(',') || input.prompt.slice(0, 64);
    const h = hash(seed);

    // Weighted so a demo run shows a realistic mix rather than all-green.
    let outcome: Outcome;
    const roll = h % 100;
    if (roll < 70) outcome = 'fixed';
    else if (roll < 85) outcome = 'blocked';
    else if (roll < 93) outcome = 'finished_no_pr';
    else outcome = 'expired';
    if (this.opts.forceOutcome) outcome = this.opts.forceOutcome;

    const id = `mock-session-${++this.counter}-${(h % 100000).toString(36)}`;
    this.sessions.set(id, {
      id,
      input,
      polls: 0,
      createdAt: new Date().toISOString(),
      outcome,
      pollsUntilTerminal: this.opts.pollsUntilTerminal ?? 2,
    });

    return { session_id: id, url: `https://app.devin.ai/sessions/${id}`, is_new_session: true };
  }

  async getSession(sessionId: string): Promise<SessionDetail> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`mock session ${sessionId} not found`);
    s.polls++;

    const base: SessionDetail = {
      session_id: s.id,
      status: 'running',
      status_enum: 'working',
      title: s.input.title ?? 'Mock remediation',
      created_at: s.createdAt,
      updated_at: new Date().toISOString(),
      tags: s.input.tags ?? [],
      acu_used: Number((s.polls * 0.4).toFixed(2)),
      messages: [{ type: 'devin_message', message: `working (poll ${s.polls})` }],
    };

    if (s.polls <= s.pollsUntilTerminal) return base;

    const contractId = (s.input.tags ?? []).find((t) => t.startsWith('contract:'))?.split(':')[1];
    const branch = `autopilot/${(contractId ?? 'fix').toLowerCase()}`;

    switch (s.outcome) {
      case 'fixed':
        return {
          ...base,
          status: 'finished',
          status_enum: 'finished',
          pull_request: { url: `https://github.com/watilde/superset/pull/${900 + this.counter}` },
          structured_output: {
            status: 'fixed',
            summary: `Applied the remediation described in ${contractId ?? 'the issue'} and verified it locally.`,
            files_changed: [`superset/example_${this.counter}.py`],
            verification_passed: true,
            verification_output: 'all verification commands exited 0',
            pull_request_url: `https://github.com/watilde/superset/pull/${900 + this.counter}`,
            confidence: 'high',
            branch,
          },
        };

      case 'blocked':
        return {
          ...base,
          status: 'blocked',
          status_enum: 'blocked',
          messages: [
            ...(base.messages ?? []),
            {
              type: 'devin_message',
              message:
                'The fix touches a public interface. Please confirm whether backwards compatibility is required.',
            },
          ],
        };

      case 'finished_no_pr':
        // The genuinely awkward case: Devin finished but produced no PR. The
        // orchestrator must treat this as a failure, not a success.
        return {
          ...base,
          status: 'finished',
          status_enum: 'finished',
          pull_request: null,
          structured_output: {
            status: 'no_change_needed',
            summary: 'Investigated the report and concluded the current behaviour is correct.',
            files_changed: [],
            verification_passed: false,
            verification_output: 'no changes made',
            pull_request_url: null,
            confidence: 'medium',
          },
        };

      case 'expired':
      default:
        return { ...base, status: 'expired', status_enum: 'expired' };
    }
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`mock session ${sessionId} not found`);
    s.polls = 0; // an unblocking reply puts the session back to work
    if (s.outcome === 'blocked') s.outcome = 'fixed';
    s.input.prompt += `\n\n[operator] ${message}`;
  }

  async terminateSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

import type {
  CreateSessionInput,
  CreateSessionResult,
  DevinClient,
  NormalizedSession,
} from './types.js';

/**
 * A deterministic, in-process stand-in for Devin.
 *
 * This exists so the whole pipeline — webhook, dispatch, reconcile, report —
 * can be exercised in CI and in a reviewer's terminal without an API key and
 * without spending ACUs. It is not a toy: it reproduces the states the
 * orchestrator actually has to handle, including the awkward ones (blocked,
 * expired, and a session that finishes without opening a PR).
 *
 * Outcomes derive from a hash of the session tags, so the same issue always
 * produces the same result and demos are repeatable.
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
  outcome: Outcome;
  pollsUntilTerminal: number;
}

export interface MockOptions {
  /** Polls spent running before reaching a terminal state. */
  pollsUntilTerminal?: number;
  /** Force every session to one outcome (used by tests). */
  forceOutcome?: Outcome;
}

export class DevinMockClient implements DevinClient {
  readonly mode = 'mock' as const;
  readonly apiVersion = 'mock' as const;
  private sessions = new Map<string, MockSession>();
  private counter = 0;
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
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
      outcome,
      pollsUntilTerminal: this.opts.pollsUntilTerminal ?? 2,
    });

    return { sessionId: id, url: `https://app.devin.ai/sessions/${id}`, isNewSession: true };
  }

  async getSession(sessionId: string): Promise<NormalizedSession> {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`mock session ${sessionId} not found`);
    s.polls++;

    const base: NormalizedSession = {
      sessionId: s.id,
      url: `https://app.devin.ai/sessions/${s.id}`,
      state: 'running',
      rawStatus: 'running/working',
      structuredOutput: null,
      pullRequestUrl: null,
      acuUsed: Number((s.polls * 0.4).toFixed(2)),
      lastMessage: `working (poll ${s.polls})`,
    };

    if (s.polls <= s.pollsUntilTerminal) return base;

    const contractId = (s.input.tags ?? []).find((t) => t.startsWith('contract:'))?.split(':')[1];
    const prUrl = `https://github.com/watilde/superset/pull/${900 + this.counter}`;

    switch (s.outcome) {
      case 'fixed':
        return {
          ...base,
          state: 'finished',
          rawStatus: 'exit/finished',
          pullRequestUrl: prUrl,
          structuredOutput: {
            status: 'fixed',
            summary: `Applied the remediation described in ${contractId ?? 'the issue'} and verified it locally.`,
            files_changed: [`superset/example_${this.counter}.py`],
            verification_passed: true,
            verification_output: 'all verification commands exited 0',
            pull_request_url: prUrl,
            confidence: 'high',
          },
        };

      case 'blocked':
        return {
          ...base,
          state: 'blocked',
          rawStatus: 'running/waiting_for_user',
          lastMessage:
            'The fix touches a public interface. Please confirm whether backwards compatibility is required.',
        };

      case 'finished_no_pr':
        // The genuinely awkward case: Devin finished but produced no PR.
        return {
          ...base,
          state: 'finished',
          rawStatus: 'exit/finished',
          pullRequestUrl: null,
          structuredOutput: {
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
        // Must be a status that normalizeV3 genuinely maps to `failed` —
        // `exit/inactivity` would normalise to `finished`, so using it here
        // would make the mock disagree with the real API.
        return { ...base, state: 'failed', rawStatus: 'exit/error' };
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

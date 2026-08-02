import { logger } from '../logger.js';
import { DevinHttp, type DevinHttpOptions } from './http.js';
import type {
  CreateSessionInput,
  CreateSessionResult,
  DevinClient,
  DevinPlatformApi,
  DevinSchedule,
  DevinSessionInsight,
  DevinSessionState,
  NormalizedSession,
} from './types.js';

interface V3SessionResponse {
  session_id: string;
  url?: string | null;
  status?: string;
  status_detail?: string | null;
  structured_output?: Record<string, unknown> | null;
  pull_requests?: Array<{ pr_url?: string | null; pr_state?: string | null }> | null;
  acus_consumed?: number | null;
}

export interface V3Message {
  /** `user` for anything we sent, `devin` for the agent's own replies. */
  source?: string | null;
  message?: string | null;
  content?: string | null;
  created_at?: string | null;
}

interface V3MessagesResponse {
  /** v3 paginates under `items`; the other keys are defensive fallbacks. */
  items?: V3Message[];
  messages?: V3Message[];
  data?: V3Message[];
}

/**
 * Picks the question to show a human when a session blocks.
 *
 * Two things make this less obvious than "take the last message". The list
 * includes our own dispatch prompt with `source: "user"`, so a naive tail read
 * echoes Autopilot's own instructions back onto the issue as though Devin had
 * asked them. And v3 returns the array under `items`, not `messages` — reading
 * the wrong key fails silently and yields a blocked notice with no question,
 * which is exactly useless to whoever has to unblock it.
 */
export function pickLastDevinMessage(res: V3MessagesResponse): string | null {
  const list = res.items ?? res.messages ?? res.data ?? [];
  const text = (m: V3Message) => (m.message ?? m.content ?? '').trim();

  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.source !== 'user' && text(m)) return text(m);
  }
  // No agent message yet — better to say nothing than to quote ourselves.
  return null;
}

/**
 * Terminal `status_detail` values that mean the session stopped for a reason
 * that is not "it did the work" — quota, billing and hard errors. These become
 * failures regardless of anything the session may have produced.
 */
const FATAL_DETAIL = new Set([
  'error',
  'usage_limit_exceeded',
  'out_of_credits',
  'out_of_quota',
  'no_quota_allocation',
  'payment_declined',
  'org_usage_limit_exceeded',
  'user_usage_limit_exceeded',
  'total_session_limit_exceeded',
]);

/** Session is stopped and waiting on a human. */
const WAITING_DETAIL = new Set(['waiting_for_user', 'waiting_for_approval']);

export interface DevinV3ClientOptions extends DevinHttpOptions {
  /** Organization id, `org-…`, from Settings → Service Users. */
  orgId: string;
}

/**
 * Client for the current v3 API (`cog_*` service-user credentials).
 *
 * Two things differ enough from v1 to be worth calling out: the org id is part
 * of every path, and lifecycle is split across `status` and `status_detail` —
 * so "did it finish successfully" needs both fields, not one.
 */
interface V3InsightItem {
  session_id: string;
  url?: string | null;
  title?: string | null;
  status?: string | null;
  status_detail?: string | null;
  tags?: string[] | null;
  playbook_id?: string | null;
  acus_consumed?: number | null;
  pull_requests?: Array<{ pr_url?: string | null; pr_state?: string | null }> | null;
  created_at?: number | string | null;
}

interface V3ScheduleItem {
  scheduled_session_id: string;
  name?: string | null;
  frequency?: string | null;
  enabled?: boolean | null;
  last_executed_at?: string | null;
}

/** Session timestamps come back as Unix seconds; the rest of the app uses ISO. */
function toIso(value: number | string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === 'number') return new Date(value * 1000).toISOString();
  return value;
}

export class DevinV3Client implements DevinClient, DevinPlatformApi {
  readonly mode = 'live' as const;
  readonly apiVersion = 'v3' as const;
  private readonly http: DevinHttp;
  private readonly orgId: string;

  constructor(opts: DevinV3ClientOptions) {
    this.http = new DevinHttp(opts);
    this.orgId = opts.orgId;
  }

  private base(): string {
    return `/organizations/${encodeURIComponent(this.orgId)}/sessions`;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    // v3 has no `idempotent` flag — the store's in-flight guard is the only
    // thing preventing duplicate sessions here, which is why that guard is
    // tested rather than assumed.
    const res = await this.http.request<V3SessionResponse>('POST', this.base(), {
      prompt: input.prompt,
      title: input.title,
      tags: input.tags,
      playbook_id: input.playbookId,
      max_acu_limit: input.maxAcuLimit,
      structured_output_schema: input.structuredOutputSchema,
      structured_output_required: Boolean(input.structuredOutputSchema),
    });
    return {
      sessionId: res.session_id,
      url: res.url ?? `https://app.devin.ai/sessions/${res.session_id}`,
      isNewSession: true,
    };
  }

  async getSession(sessionId: string): Promise<NormalizedSession> {
    const s = await this.http.request<V3SessionResponse>(
      'GET',
      `${this.base()}/${encodeURIComponent(sessionId)}`,
    );
    const normalized = normalizeV3(s);

    // v3 does not inline messages, so fetch the blocking question only when we
    // actually need it — one extra call per blocked session, not per poll.
    if (normalized.state === 'blocked' && !normalized.lastMessage) {
      normalized.lastMessage = await this.lastMessage(sessionId);
    }
    return normalized;
  }

  private async lastMessage(sessionId: string): Promise<string | null> {
    try {
      const res = await this.http.request<V3MessagesResponse>(
        'GET',
        `${this.base()}/${encodeURIComponent(sessionId)}/messages`,
      );
      return pickLastDevinMessage(res);
    } catch (err) {
      // Purely for the status comment — never let it break reconciliation.
      logger.debug({ sessionId, err: (err as Error).message }, 'could not fetch session messages');
    }
    return null;
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    await this.http.request('POST', `${this.base()}/${encodeURIComponent(sessionId)}/messages`, {
      message,
    });
  }

  async terminateSession(sessionId: string): Promise<void> {
    await this.http.request('DELETE', `${this.base()}/${encodeURIComponent(sessionId)}`);
  }

  // --- platform features (v3 only) ------------------------------------------

  /**
   * Sessions as Devin's own analytics reports them.
   *
   * This is the independent view: same sessions, counted by the provider
   * rather than by us. It is what lets the dashboard show that the tags and
   * prompts Autopilot claims to have sent are the ones Devin actually received.
   */
  async listSessionInsights(limit = 50): Promise<DevinSessionInsight[]> {
    const res = await this.http.request<{ items?: V3InsightItem[] }>(
      'GET',
      `/organizations/${encodeURIComponent(this.orgId)}/sessions/insights`,
    );
    return (res.items ?? []).slice(0, limit).map((s) => ({
      sessionId: s.session_id,
      url: s.url ?? null,
      title: s.title ?? null,
      status: String(s.status ?? ''),
      statusDetail: s.status_detail ?? null,
      tags: s.tags ?? [],
      playbookId: s.playbook_id ?? null,
      acusConsumed: typeof s.acus_consumed === 'number' ? s.acus_consumed : null,
      pullRequests: (s.pull_requests ?? [])
        .filter((p) => p?.pr_url)
        .map((p) => ({ url: String(p.pr_url), state: String(p.pr_state ?? 'unknown') })),
      createdAt: toIso(s.created_at),
    }));
  }

  async createPlaybook(input: {
    title: string;
    body: string;
    structuredOutputSchema?: Record<string, unknown>;
  }): Promise<{ playbookId: string; title: string }> {
    const res = await this.http.request<{ playbook_id: string; title: string }>(
      'POST',
      `/organizations/${encodeURIComponent(this.orgId)}/playbooks`,
      {
        title: input.title,
        body: input.body,
        structured_output_schema: input.structuredOutputSchema,
      },
    );
    return { playbookId: res.playbook_id, title: res.title };
  }

  async listSchedules(): Promise<DevinSchedule[]> {
    const res = await this.http.request<{ items?: V3ScheduleItem[] }>(
      'GET',
      `/organizations/${encodeURIComponent(this.orgId)}/schedules`,
    );
    return (res.items ?? []).map(toSchedule);
  }

  async createSchedule(input: {
    name: string;
    prompt: string;
    frequency: string;
    playbookId?: string;
    tags?: string[];
  }): Promise<DevinSchedule> {
    const res = await this.http.request<V3ScheduleItem>(
      'POST',
      `/organizations/${encodeURIComponent(this.orgId)}/schedules`,
      {
        name: input.name,
        prompt: input.prompt,
        schedule_type: 'recurring',
        frequency: input.frequency,
        playbook_id: input.playbookId,
        tags: input.tags,
        notify_on: 'failure',
      },
    );
    return toSchedule(res);
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.http.request(
      'DELETE',
      `/organizations/${encodeURIComponent(this.orgId)}/schedules/${encodeURIComponent(scheduleId)}`,
    );
  }
}

function toSchedule(s: V3ScheduleItem): DevinSchedule {
  return {
    scheduleId: s.scheduled_session_id,
    name: s.name ?? '',
    frequency: s.frequency ?? null,
    enabled: s.enabled ?? true,
    lastExecutedAt: s.last_executed_at ?? null,
  };
}

export function normalizeV3(s: V3SessionResponse): NormalizedSession {
  const status = String(s.status ?? '');
  const detail = String(s.status_detail ?? '');

  let state: DevinSessionState;
  if (status === 'error' || FATAL_DETAIL.has(detail)) {
    state = 'failed';
  } else if (WAITING_DETAIL.has(detail) || status === 'suspended') {
    // A suspended session will not progress on its own, so surface it as
    // blocked rather than letting it masquerade as running until timeout.
    state = 'blocked';
  } else if (status === 'exit') {
    // `inactivity` and `user_request` still count as finished: the session may
    // well have opened a PR before stopping, and judge() decides on evidence.
    state = 'finished';
  } else {
    // new / claimed / running / resuming
    state = 'running';
  }

  const pr = (s.pull_requests ?? []).find(
    (p) => typeof p?.pr_url === 'string' && p.pr_url.trim(),
  )?.pr_url;

  return {
    sessionId: s.session_id,
    url: s.url ?? null,
    state,
    rawStatus: detail ? `${status}/${detail}` : status,
    structuredOutput: s.structured_output ?? null,
    pullRequestUrl: pr ?? null,
    acuUsed: typeof s.acus_consumed === 'number' ? s.acus_consumed : null,
    lastMessage: null,
  };
}

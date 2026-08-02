import { DevinHttp, type DevinHttpOptions } from './http.js';
import type {
  CreateSessionInput,
  CreateSessionResult,
  DevinClient,
  DevinSessionState,
  NormalizedSession,
} from './types.js';

/** Raw v1 payloads, only as much as we actually read. */
interface V1CreateResponse {
  session_id: string;
  url: string;
  is_new_session?: boolean | null;
}

interface V1SessionResponse {
  session_id: string;
  url?: string | null;
  status?: string;
  status_enum?: string | null;
  structured_output?: Record<string, unknown> | null;
  pull_request?: { url?: string | null } | null;
  messages?: Array<{ message?: string }>;
  acu_used?: number | null;
}

/**
 * Client for the deprecated v1 API (`apk_*` keys).
 *
 * Retained because plenty of existing keys are still v1, and the whole point of
 * normalising is that supporting both costs one small class rather than a fork
 * of the orchestrator.
 */
export class DevinV1Client implements DevinClient {
  readonly mode = 'live' as const;
  readonly apiVersion = 'v1' as const;
  private readonly http: DevinHttp;

  constructor(opts: DevinHttpOptions) {
    this.http = new DevinHttp(opts);
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    const res = await this.http.request<V1CreateResponse>('POST', '/sessions', {
      prompt: input.prompt,
      title: input.title,
      tags: input.tags,
      playbook_id: input.playbookId,
      idempotent: input.idempotent ?? true,
      max_acu_limit: input.maxAcuLimit,
      structured_output_schema: input.structuredOutputSchema,
    });
    return { sessionId: res.session_id, url: res.url, isNewSession: res.is_new_session ?? null };
  }

  async getSession(sessionId: string): Promise<NormalizedSession> {
    const s = await this.http.request<V1SessionResponse>(
      'GET',
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    return normalizeV1(s);
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    await this.http.request('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, {
      message,
    });
  }

  async terminateSession(sessionId: string): Promise<void> {
    await this.http.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
  }
}

export function normalizeV1(s: V1SessionResponse): NormalizedSession {
  const raw = String(s.status_enum ?? s.status ?? '');

  let state: DevinSessionState;
  switch (raw) {
    case 'finished':
      state = 'finished';
      break;
    case 'expired':
      state = 'failed';
      break;
    case 'blocked':
      state = 'blocked';
      break;
    default:
      // working / resumed / suspend_requested / resume_requested / …
      state = 'running';
  }

  const messages = s.messages ?? [];
  let lastMessage: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]?.message;
    if (typeof m === 'string' && m.trim()) {
      lastMessage = m.trim();
      break;
    }
  }

  return {
    sessionId: s.session_id,
    url: s.url ?? null,
    state,
    rawStatus: raw,
    structuredOutput: s.structured_output ?? null,
    pullRequestUrl: s.pull_request?.url ?? null,
    acuUsed: typeof s.acu_used === 'number' ? s.acu_used : null,
    lastMessage,
  };
}

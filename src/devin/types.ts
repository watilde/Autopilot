/**
 * Devin API types.
 *
 * Devin has two live API generations and they disagree about almost everything
 * that matters here: v1 reports `status_enum`, a single `pull_request` object
 * and no cost field; v3 reports `status` + `status_detail`, a `pull_requests`
 * array and `acus_consumed`. Authentication differs too — v1 takes `apk_*`
 * keys, v3 takes `cog_*` service-user credentials and needs an org id in the
 * path.
 *
 * Rather than teach the orchestrator both dialects, each client normalises
 * into the `NormalizedSession` below. The orchestrator only ever sees a
 * lifecycle state, a PR url, structured output and a cost — so adding a future
 * v4 means writing one normaliser, not touching the state machine.
 *
 * Reference: https://docs.devin.ai/api-reference/overview
 */

export type DevinApiVersion = 'v1' | 'v3';

/** The only lifecycle vocabulary the orchestrator knows about. */
export type DevinSessionState = 'running' | 'blocked' | 'finished' | 'failed';

export interface CreateSessionInput {
  prompt: string;
  title?: string;
  tags?: string[];
  maxAcuLimit?: number;
  /** JSON Schema Devin must populate, so results are data rather than prose. */
  structuredOutputSchema?: Record<string, unknown>;
  /** v1 only; v3 has no equivalent field. Ignored by the v3 client. */
  idempotent?: boolean;
}

export interface CreateSessionResult {
  sessionId: string;
  url: string;
  isNewSession?: boolean | null;
}

/** Version-agnostic view of a session, produced by each client's normaliser. */
export interface NormalizedSession {
  sessionId: string;
  url: string | null;
  state: DevinSessionState;
  /** Provider status string, kept verbatim for logs and the audit trail. */
  rawStatus: string;
  structuredOutput: Record<string, unknown> | null;
  pullRequestUrl: string | null;
  acuUsed: number | null;
  /** Most recent agent message; used to surface a blocking question. */
  lastMessage: string | null;
}

export interface DevinClient {
  readonly mode: 'live' | 'mock';
  readonly apiVersion: DevinApiVersion | 'mock';
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  getSession(sessionId: string): Promise<NormalizedSession>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  terminateSession(sessionId: string): Promise<void>;
}

export class DevinApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    /** Transport blips and rate limits are worth retrying; 4xx is not. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DevinApiError';
  }
}

/**
 * Infers the API generation from the credential, because getting this wrong
 * fails with an opaque 403 rather than anything actionable. `cog_` keys are
 * v3-only service users; `apk_`/`apk_user_` are the deprecated v1/v2 keys.
 */
export function inferApiVersion(apiKey: string): DevinApiVersion {
  return apiKey.startsWith('cog_') ? 'v3' : 'v1';
}

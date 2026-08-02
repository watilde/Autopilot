/**
 * Types for the Devin v1 REST API.
 * Reference: https://docs.devin.ai/api-reference/overview
 */

/** Lifecycle values Devin reports on `status_enum`. */
export type DevinStatus =
  | 'working'
  | 'blocked'
  | 'expired'
  | 'finished'
  | 'suspend_requested'
  | 'suspend_requested_frontend'
  | 'resume_requested'
  | 'resume_requested_frontend'
  | 'resumed';

export interface CreateSessionInput {
  prompt: string;
  title?: string;
  /**
   * Ask Devin to reuse an existing session for an identical prompt instead of
   * starting a second one. Our own DB guard is the primary defence against
   * duplicate work; this is defence in depth at the provider.
   */
  idempotent?: boolean;
  tags?: string[];
  max_acu_limit?: number;
  /** JSON Schema Devin must populate, so we get data back instead of prose. */
  structured_output_schema?: Record<string, unknown>;
  playbook_id?: string;
  snapshot_id?: string;
  unlisted?: boolean;
}

export interface CreateSessionResponse {
  session_id: string;
  url: string;
  is_new_session?: boolean | null;
}

export interface DevinPullRequest {
  url?: string | null;
}

export interface DevinSessionMessage {
  type?: string;
  message?: string;
  timestamp?: string;
  [k: string]: unknown;
}

export interface SessionDetail {
  session_id: string;
  status: string;
  status_enum?: DevinStatus | null;
  title?: string | null;
  created_at?: string;
  updated_at?: string;
  messages?: DevinSessionMessage[];
  structured_output?: Record<string, unknown> | null;
  pull_request?: DevinPullRequest | null;
  tags?: string[] | null;
  /**
   * Not documented on every plan, so it is read defensively and only used for
   * cost reporting. A missing value degrades the ACU column, nothing else.
   */
  acu_used?: number | null;
  [k: string]: unknown;
}

export interface DevinClient {
  readonly mode: 'live' | 'mock';
  createSession(input: CreateSessionInput): Promise<CreateSessionResponse>;
  getSession(sessionId: string): Promise<SessionDetail>;
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

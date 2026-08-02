import { logger } from '../logger.js';
import {
  DevinApiError,
  type CreateSessionInput,
  type CreateSessionResponse,
  type DevinClient,
  type SessionDetail,
} from './types.js';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface DevinHttpClientOptions {
  apiKey: string;
  baseUrl: string;
  maxRetries?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Thin, dependency-free client over the Devin v1 REST API.
 *
 * The only cleverness here is retry policy: session creation is the one call
 * that costs money, so it is retried on transport failures but never on a 4xx,
 * and the caller pairs it with an idempotency guard. Everything else is a
 * straightforward fetch.
 */
export class DevinHttpClient implements DevinClient {
  readonly mode = 'live' as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DevinHttpClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResponse> {
    return this.request<CreateSessionResponse>('POST', '/sessions', input);
  }

  async getSession(sessionId: string): Promise<SessionDetail> {
    return this.request<SessionDetail>('GET', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  async sendMessage(sessionId: string, message: string): Promise<void> {
    await this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { message });
  }

  async terminateSession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        const text = await res.text();

        if (!res.ok) {
          const retryable = RETRYABLE_STATUS.has(res.status);
          const err = new DevinApiError(
            `Devin API ${method} ${path} failed with ${res.status}`,
            res.status,
            text.slice(0, 2000),
            retryable,
          );
          if (!retryable || attempt === this.maxRetries) throw err;
          lastError = err;
          await this.backoff(attempt, res.headers.get('retry-after'));
          continue;
        }

        return (text ? JSON.parse(text) : {}) as T;
      } catch (err) {
        // A DevinApiError that reached here was already judged non-retryable.
        if (err instanceof DevinApiError) throw err;
        lastError = err as Error;
        const isAbort = (err as Error).name === 'AbortError';
        logger.warn(
          { attempt, method, path, err: (err as Error).message, isAbort },
          'devin request failed, retrying',
        );
        if (attempt === this.maxRetries) break;
        await this.backoff(attempt, null);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new DevinApiError(
      `Devin API ${method} ${path} failed after ${this.maxRetries} attempts: ${lastError?.message}`,
      0,
      String(lastError?.message ?? ''),
      true,
    );
  }

  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    const headerMs = retryAfter ? Number(retryAfter) * 1000 : NaN;
    const base = Number.isFinite(headerMs) ? headerMs : 2 ** attempt * 500;
    // Jitter so a burst of reconciler polls does not resynchronise on retry.
    const wait = Math.min(base + Math.random() * 250, 30_000);
    await new Promise((r) => setTimeout(r, wait));
  }
}

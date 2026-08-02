import { logger } from '../logger.js';
import { DevinApiError } from './types.js';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface DevinHttpOptions {
  apiKey: string;
  baseUrl: string;
  maxRetries?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Shared transport for both API generations.
 *
 * The retry policy is the only opinionated part: session creation costs money,
 * so it retries transport failures and 429s but never a 4xx, and the caller
 * pairs it with an idempotency guard. Backoff is jittered so a burst of
 * reconciler polls doesn't resynchronise on retry.
 */
export class DevinHttp {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DevinHttpOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
        // A DevinApiError reaching here was already judged non-retryable.
        if (err instanceof DevinApiError) throw err;
        lastError = err as Error;
        logger.warn(
          { attempt, method, path, err: (err as Error).message },
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
    const wait = Math.min(base + Math.random() * 250, 30_000);
    await new Promise((r) => setTimeout(r, wait));
  }
}

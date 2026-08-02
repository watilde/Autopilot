import { config } from '../config.js';
import type { GitHubClient } from '../github/client.js';
import { logger } from '../logger.js';
import type { Orchestrator } from './orchestrator.js';

/**
 * The second trigger: a periodic sweep for labelled issues.
 *
 * Webhooks are the fast path, but they are also a single point of failure —
 * a delivery dropped while the service was restarting is simply lost, and the
 * issue sits labelled and untouched forever. This sweep closes that gap. It
 * relies on the same intake path, and intake already deduplicates, so a
 * webhook and a scan racing on the same issue is harmless by construction.
 *
 * This is also what makes the system usable without any webhook plumbing at
 * all: label an issue, wait for the next sweep.
 */
export class Scanner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly github: GitHubClient,
    private readonly orchestrator: Orchestrator,
    private readonly intervalMs: number,
  ) {}

  async scan(): Promise<{ examined: number; accepted: number }> {
    if (!this.github.enabled) return { examined: 0, accepted: 0 };
    if (this.running) return { examined: 0, accepted: 0 };
    this.running = true;

    try {
      const issues = await this.github.listIssuesByLabel(config.AUTOPILOT_LABEL);
      let accepted = 0;
      for (const issue of issues) {
        const result = await this.orchestrator.intake(issue, 'scheduled-scan');
        if (result.accepted) accepted++;
      }
      if (accepted > 0) {
        logger.info({ examined: issues.length, accepted }, 'scheduled scan queued new work');
      } else {
        logger.debug({ examined: issues.length }, 'scheduled scan found nothing new');
      }
      return { examined: issues.length, accepted };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'scheduled scan failed');
      return { examined: 0, accepted: 0 };
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer || !this.github.enabled) return;
    logger.info({ intervalMs: this.intervalMs }, 'scheduled scanner started');
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

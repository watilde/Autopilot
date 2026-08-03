import { config } from '../config.js';
import type { Store } from '../db/index.js';
import type { DevinClient } from '../devin/types.js';
import type { GitHubClient } from '../github/client.js';
import { logger } from '../logger.js';
import * as metrics from '../obs/metrics.js';
import { AUDIT_OUTPUT_SCHEMA, auditPrompt } from './prompt.js';

/**
 * The front of the chain: finding the defect at all.
 *
 * Everything else in this system starts at "someone labelled an issue", which
 * leaves the hardest and least rewarded step as manual work — and it is exactly
 * the work that loses to feature delivery. An audit session reads the
 * repository, decides what is worth fixing, and files contract-carrying issues.
 * Those arrive back through the ordinary webhook path, so nothing downstream
 * knows or cares that an agent wrote them: intake still refuses anything
 * without a valid contract, and a bad audit produces refusals rather than
 * sessions.
 *
 * `npm run devin:setup` registers this same prompt as a schedule on Devin's
 * side, which is the right shape for a cadence. This class is the other half —
 * the on-demand trigger, tracked here, so the audit is a thing Autopilot did
 * rather than a thing that happened to it.
 *
 * Audits produce no remediation, so there is no row to hang them on. They live
 * in the event log: `audit.dispatched` when one starts, `audit.finished` when
 * it ends, carrying what it filed. In-flight is derived by subtracting one from
 * the other, which keeps a second table out of the schema for a feature that
 * runs a handful of times a day.
 */

interface AuditDetail {
  sessionId?: string;
  url?: string;
  trigger?: string;
}

export interface AuditStatus {
  sessionId: string;
  url: string | null;
  dispatchedAt: string;
}

export class AuditRunner {
  constructor(
    private readonly store: Store,
    private readonly devin: DevinClient,
    private readonly github: GitHubClient,
  ) {}

  /**
   * Audits currently running. Bounded lookback rather than a full scan: an
   * audit that has been open for hundreds of events is not in flight, it is
   * lost, and treating it as live would block every later one.
   */
  inFlight(): AuditStatus[] {
    const cutoff = Date.now() - config.AUDIT_TIMEOUT_MS;
    const started = this.store.listEvents(20, 'audit.dispatched');
    const finished = new Set(
      this.store
        .listEvents(50, 'audit.finished')
        .map((e) => (e.detail as AuditDetail)?.sessionId)
        .filter(Boolean),
    );

    return started
      .filter((e) => {
        const id = (e.detail as AuditDetail)?.sessionId;
        return id && !finished.has(id);
      })
      // An audit older than the bound is not in flight, it is lost — cancelled
      // from the Devin dashboard, or stuck. Both look like `blocked` from here.
      .filter((e) => new Date(e.createdAt).getTime() >= cutoff)
      .map((e) => ({
        sessionId: (e.detail as AuditDetail).sessionId!,
        url: (e.detail as AuditDetail).url ?? null,
        dispatchedAt: e.createdAt,
      }));
  }

  /**
   * Start an audit.
   *
   * One at a time. Two audits reading the same repository at the same time
   * would file the same defects twice — the duplicates would be refused at
   * intake, so nothing bad reaches Devin, but the issues would already exist on
   * GitHub and somebody would have to close them.
   */
  async dispatch(trigger: string): Promise<{
    dispatched: boolean;
    reason: string;
    sessionId?: string;
    url?: string;
  }> {
    const open = this.inFlight();
    if (open.length) {
      return {
        dispatched: false,
        reason: `an audit is already running (${open[0]!.sessionId})`,
        sessionId: open[0]!.sessionId,
        url: open[0]!.url ?? undefined,
      };
    }

    try {
      const session = await this.devin.createSession({
        prompt: auditPrompt(this.github.owner, this.github.repo, config.AUTOPILOT_LABEL),
        title: `[Autopilot audit] ${this.github.owner}/${this.github.repo}`,
        tags: [
          'autopilot',
          'audit',
          `repo:${this.github.owner}/${this.github.repo}`,
          `trigger:${trigger}`,
        ],
        maxAcuLimit: config.DEVIN_MAX_ACU,
        structuredOutputSchema: AUDIT_OUTPUT_SCHEMA,
        playbookId: config.DEVIN_PLAYBOOK_ID,
      });

      this.store.appendEvent({
        type: 'audit.dispatched',
        detail: { sessionId: session.sessionId, url: session.url, trigger },
      });
      metrics.audits.inc({ result: 'dispatched' });
      logger.info({ session: session.sessionId, url: session.url, trigger }, 'audit dispatched');

      return {
        dispatched: true,
        reason: 'audit session created',
        sessionId: session.sessionId,
        url: session.url,
      };
    } catch (err) {
      metrics.audits.inc({ result: 'error' });
      logger.warn({ err: (err as Error).message, trigger }, 'could not dispatch an audit');
      return { dispatched: false, reason: `could not create the session: ${(err as Error).message}` };
    }
  }

  /**
   * Poll in-flight audits and close out the ones that ended.
   *
   * What it filed is recorded, but only as the session's own account of what it
   * did. The issues themselves arrive through the webhook path and are counted
   * there; if the session claims three and GitHub has one, the event log shows
   * the claim and the remediations show the truth.
   */
  /**
   * Write off the audit in flight, on an operator's say-so.
   *
   * The timeout is the safety net; this is the hand on the switch. Cancelling a
   * session on Devin's side does not tell Autopilot anything — the session goes
   * on reporting `running/waiting_for_user`, indistinguishable from one that
   * stopped to ask a question — so without this, the person who just cancelled
   * it has to wait out the bound before they can start another.
   */
  async abandon(reason: string): Promise<{ abandoned: boolean; reason: string }> {
    const [open] = this.inFlight();
    if (!open) return { abandoned: false, reason: 'no audit is running' };

    try {
      await this.devin.terminateSession(open.sessionId);
    } catch {
      /* best effort: it may already be gone, which is the usual case here */
    }

    this.store.appendEvent({
      type: 'audit.finished',
      detail: { sessionId: open.sessionId, url: open.url, state: 'abandoned', filed: 0, reason },
    });
    metrics.audits.inc({ result: 'abandoned' });
    logger.info({ session: open.sessionId, reason }, 'audit abandoned');
    return { abandoned: true, reason: `abandoned ${open.sessionId}` };
  }

  async reconcile(): Promise<number> {
    let settled = 0;

    for (const audit of this.inFlight()) {
      let session;
      try {
        session = await this.devin.getSession(audit.sessionId);
      } catch (err) {
        logger.warn(
          { session: audit.sessionId, err: (err as Error).message },
          'could not poll an audit session',
        );
        continue;
      }

      // `blocked` is deliberately not terminal here. An audit that stopped to
      // ask a question is still an audit in flight, and closing it out would
      // let the next one start against a repository this one is still reading.
      if (session.state !== 'finished' && session.state !== 'failed') continue;

      const output = (session.structuredOutput ?? null) as {
        issues_filed?: unknown[];
        summary?: string;
      } | null;
      const filed = Array.isArray(output?.issues_filed) ? output!.issues_filed!.length : 0;

      this.store.appendEvent({
        type: 'audit.finished',
        detail: {
          sessionId: audit.sessionId,
          url: audit.url,
          state: session.state,
          filed,
          output,
        },
      });
      metrics.audits.inc({ result: session.state === 'finished' ? 'finished' : 'failed' });
      logger.info(
        { session: audit.sessionId, state: session.state, filed },
        'audit finished',
      );
      settled++;
    }

    return settled;
  }
}

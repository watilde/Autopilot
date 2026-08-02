import { config } from '../config.js';
import type { Store } from '../db/index.js';
import { DevinApiError, type DevinClient } from '../devin/index.js';
import type { GitHubClient, IssueRef } from '../github/client.js';
import { logger } from '../logger.js';
import * as metrics from '../obs/metrics.js';
import { isTerminal, type Remediation, type RemediationState } from '../types.js';
import { branchFor, parseContract } from './contract.js';
import {
  REMEDIATION_OUTPUT_SCHEMA,
  buildPrompt,
  sessionTags,
  sessionTitle,
} from './prompt.js';

/**
 * The orchestrator owns the lifecycle of a remediation.
 *
 * It is split into three small, independently testable steps:
 *
 *   intake()    — decide whether an issue is eligible, and record it
 *   dispatch()  — turn queued work into Devin sessions, under a concurrency cap
 *   reconcile() — poll in-flight sessions and drive them to a terminal state
 *
 * Intake and dispatch are separate on purpose. Webhooks arrive in bursts (a
 * scan finishes and labels nine issues at once) and each Devin session costs
 * real money, so accepting work and starting work have to be decoupled — the
 * queue absorbs the burst and the cap controls spend.
 *
 * Reconciliation is a poll loop rather than a callback because a webhook we
 * never receive is indistinguishable from one that says nothing happened. The
 * loop is the thing that guarantees a session cannot be left "running" forever
 * just because a notification was dropped.
 */

export interface IntakeResult {
  accepted: boolean;
  reason: string;
  remediation?: Remediation;
}

export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly store: Store,
    private readonly devin: DevinClient,
    private readonly github: GitHubClient,
  ) {}

  // -------------------------------------------------------------------------
  // Intake
  // -------------------------------------------------------------------------

  /**
   * Decide whether an issue should be remediated, and if so queue it.
   * Every rejection path is recorded as an event so the dashboard can explain
   * why an issue an engineer labelled did not get picked up.
   */
  async intake(issue: IssueRef, triggeredBy: string): Promise<IntakeResult> {
    const log = logger.child({ issue: issue.number, triggeredBy });

    if (!issue.labels.includes(config.AUTOPILOT_LABEL)) {
      this.store.appendEvent({
        issueNumber: issue.number,
        type: 'intake.skipped',
        detail: { reason: 'missing autopilot label' },
      });
      return { accepted: false, reason: `issue is not labelled "${config.AUTOPILOT_LABEL}"` };
    }

    if (issue.state !== 'open') {
      return { accepted: false, reason: 'issue is closed' };
    }

    // Idempotency guard. Webhook redelivery, a double label, and the periodic
    // scanner all converge here; without this we would pay for the same fix
    // more than once.
    const active = this.store.findActiveByIssue(this.repoSlug, issue.number);
    if (active) {
      this.store.appendEvent({
        remediationId: active.id,
        issueNumber: issue.number,
        type: 'intake.deduplicated',
        detail: { existingState: active.state },
      });
      return {
        accepted: false,
        reason: `already in flight (remediation ${active.id}, state ${active.state})`,
        remediation: active,
      };
    }

    const parsed = parseContract(issue.body);
    if (!parsed.ok) {
      log.warn({ reason: parsed.reason }, 'intake rejected: invalid contract');
      this.store.appendEvent({
        issueNumber: issue.number,
        type: 'intake.rejected',
        detail: { reason: parsed.reason },
      });
      await this.github.comment(
        issue.number,
        [
          '### 🤖 Autopilot could not accept this issue',
          '',
          `**Reason:** ${parsed.reason}`,
          '',
          'Autopilot only dispatches issues that carry a machine-readable remediation',
          'contract, so that success can be verified automatically rather than assumed.',
          'Add a fenced <code>autopilot</code> block with `id`, `category`, `severity`,',
          '`targets`, `acceptance` and `verify`, then re-apply the label.',
        ].join('\n'),
      );
      metrics.dispatches.inc({ result: 'rejected', category: 'unknown' });
      return { accepted: false, reason: parsed.reason };
    }

    const contract = parsed.contract;
    const remediation = this.store.create({
      repo: this.repoSlug,
      issueNumber: issue.number,
      issueUrl: issue.htmlUrl,
      title: issue.title,
      contractId: contract.id,
      category: contract.category,
      severity: contract.severity,
      triggeredBy,
    });

    log.info({ contract: contract.id, remediation: remediation.id }, 'intake accepted');
    metrics.activeRemediations.set(this.store.countActive());
    return { accepted: true, reason: 'queued', remediation };
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /** Start Devin sessions for queued work, up to the concurrency cap. */
  async dispatch(): Promise<number> {
    const inFlight = this.store.listByState(['dispatching', 'running', 'blocked']).length;
    const capacity = Math.max(0, config.MAX_CONCURRENT_SESSIONS - inFlight);
    if (capacity === 0) return 0;

    const queued = this.store.listByState(['queued']).slice(0, capacity);
    let started = 0;

    for (const r of queued) {
      const ok = await this.startSession(r);
      if (ok) started++;
    }
    metrics.activeRemediations.set(this.store.countActive());
    return started;
  }

  private async startSession(r: Remediation): Promise<boolean> {
    const log = logger.child({ remediation: r.id, issue: r.issueNumber });

    // Re-read the issue at dispatch time rather than trusting the webhook
    // payload: the body may have been edited between labelling and dispatch,
    // and the contract is what we are about to act on.
    const issue = this.github.enabled ? await this.github.getIssue(r.issueNumber) : null;
    const body = issue?.body ?? null;
    const parsed = parseContract(body);

    if (this.github.enabled && !parsed.ok) {
      log.warn({ reason: parsed.reason }, 'dispatch aborted: contract no longer valid');
      this.store.transition(r.id, 'failed', { error: `contract invalid at dispatch: ${parsed.reason}` });
      metrics.dispatches.inc({ result: 'rejected', category: r.category ?? 'unknown' });
      return false;
    }

    // In mock/demo mode there may be no GitHub token; synthesise a contract
    // from what intake already validated so the pipeline still runs.
    const contract = parsed.ok
      ? parsed.contract
      : {
          id: r.contractId ?? 'DEMO-000',
          category: (r.category ?? 'other') as never,
          severity: (r.severity ?? 'medium') as never,
          targets: ['unknown'],
          acceptance: ['as described in the issue'],
          verify: ['true'],
        };

    this.store.transition(r.id, 'dispatching');

    const prompt = buildPrompt({
      owner: this.github.owner,
      repo: this.github.repo,
      issueNumber: r.issueNumber,
      issueTitle: r.title,
      issueUrl: r.issueUrl,
      contract,
    });

    try {
      const session = await this.devin.createSession({
        prompt,
        title: sessionTitle(contract, r.issueNumber),
        tags: sessionTags(contract, r.issueNumber),
        idempotent: true,
        maxAcuLimit: config.DEVIN_MAX_ACU,
        structuredOutputSchema: REMEDIATION_OUTPUT_SCHEMA,
      });

      this.store.transition(
        r.id,
        'running',
        { devinSessionId: session.sessionId, devinSessionUrl: session.url },
        { isNewSession: session.isNewSession ?? null, apiVersion: this.devin.apiVersion },
      );

      log.info({ session: session.sessionId, url: session.url }, 'devin session created');
      metrics.dispatches.inc({ result: 'started', category: contract.category });

      await this.github.comment(
        r.issueNumber,
        [
          '### 🤖 Autopilot dispatched this issue to Devin',
          '',
          `| | |`,
          `|---|---|`,
          `| Contract | \`${contract.id}\` (${contract.category}, ${contract.severity}) |`,
          `| Session | ${session.url} |`,
          `| Branch | \`${branchFor(contract, r.issueNumber)}\` |`,
          `| Attempt | ${r.attempt} |`,
          '',
          'Devin will read the target files, apply the minimal fix, run the',
          'verification commands from the contract, and open a pull request only',
          'if they pass. Status will be updated here when the session finishes.',
        ].join('\n'),
      );
      return true;
    } catch (err) {
      const status = err instanceof DevinApiError ? String(err.status) : 'unknown';
      metrics.devinApiErrors.inc({ operation: 'createSession', status });
      metrics.dispatches.inc({ result: 'error', category: contract.category });
      log.error({ err: (err as Error).message, status }, 'failed to create devin session');

      // Non-retryable API errors are terminal; transport failures go back to
      // the queue for the next tick to retry.
      const retryable = !(err instanceof DevinApiError) || err.retryable;
      this.store.transition(r.id, retryable ? 'queued' : 'failed', {
        error: `createSession failed: ${(err as Error).message}`,
      });
      return false;
    }
  }

  /**
   * Operator kill switch.
   *
   * A system that spends money per task needs a way to stop one without
   * stopping the process. Removing the `autopilot` label only helps if a
   * webhook is wired up — with the periodic scanner alone, or during a demo,
   * queued work would otherwise dispatch the moment capacity frees.
   *
   * Terminating the Devin session is best-effort: the remediation is recorded
   * as cancelled regardless, because a local record that disagrees with
   * reality is worse than an orphaned remote session.
   */
  async cancel(id: number, reason = 'cancelled by operator'): Promise<Remediation | null> {
    const r = this.store.get(id);
    if (!r) return null;
    if (isTerminal(r.state)) return r;

    if (r.devinSessionId) {
      try {
        await this.devin.terminateSession(r.devinSessionId);
      } catch (err) {
        logger.warn(
          { remediation: id, session: r.devinSessionId, err: (err as Error).message },
          'could not terminate devin session; cancelling locally anyway',
        );
      }
    }

    const updated = this.store.transition(r.id, 'cancelled', { error: reason });
    metrics.remediationsCompleted.inc({
      outcome: 'cancelled',
      category: r.category ?? 'unknown',
      severity: r.severity ?? 'unknown',
    });
    metrics.activeRemediations.set(this.store.countActive());
    logger.info({ remediation: id, issue: r.issueNumber, reason }, 'remediation cancelled');
    return updated;
  }

  /**
   * Answer a blocked session and put it back to work.
   *
   * `blocked` is the one non-terminal state the system cannot leave on its
   * own, so without this the only way to rescue a session was to open the
   * Devin UI or hand-roll an API call — and the remediation would sit in
   * `blocked` until it timed out, quietly counting against cycle time.
   *
   * The reply is recorded as an event, so the audit log shows who unblocked
   * what and with what answer.
   */
  async reply(id: number, message: string): Promise<Remediation | null> {
    const r = this.store.get(id);
    if (!r || !r.devinSessionId) return null;
    if (isTerminal(r.state)) return r;

    await this.devin.sendMessage(r.devinSessionId, message);

    this.store.appendEvent({
      remediationId: r.id,
      issueNumber: r.issueNumber,
      type: 'remediation.reply',
      detail: { message },
    });

    // Optimistically back to running; the next reconcile confirms from Devin.
    const updated = r.state === 'blocked' ? this.store.transition(r.id, 'running', {}, { reply: true }) : r;
    logger.info({ remediation: id, issue: r.issueNumber }, 'replied to session');
    return updated;
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  /** Poll every in-flight session and apply any state change. */
  async reconcile(): Promise<void> {
    const inFlight = this.store
      .listByState(['dispatching', 'running', 'blocked'])
      .filter((r) => r.devinSessionId);

    for (const r of inFlight) {
      try {
        await this.reconcileOne(r);
      } catch (err) {
        const status = err instanceof DevinApiError ? String(err.status) : 'unknown';
        metrics.devinApiErrors.inc({ operation: 'getSession', status });
        logger.warn(
          { remediation: r.id, session: r.devinSessionId, err: (err as Error).message },
          'reconcile failed for session, will retry next tick',
        );
      }
    }
    metrics.activeRemediations.set(this.store.countActive());
  }

  private async reconcileOne(r: Remediation): Promise<void> {
    const log = logger.child({ remediation: r.id, issue: r.issueNumber, session: r.devinSessionId });

    // A session that outlives the timeout is failed here rather than left to
    // sit in `running` forever. An orchestrator that cannot time out is an
    // orchestrator that silently leaks work.
    const ageMs = Date.now() - new Date(r.createdAt).getTime();
    if (ageMs > config.SESSION_TIMEOUT_MS) {
      log.warn({ ageMs }, 'remediation timed out');
      await this.finish(r, 'timed_out', { error: `exceeded ${config.SESSION_TIMEOUT_MS}ms` });
      try {
        await this.devin.terminateSession(r.devinSessionId!);
      } catch {
        // Best effort — the remediation is already recorded as timed out.
      }
      return;
    }

    // Normalised by the client, so this switch is identical for v1 and v3.
    const session = await this.devin.getSession(r.devinSessionId!);
    const acu = session.acuUsed ?? undefined;
    const output = session.structuredOutput;

    switch (session.state) {
      case 'finished': {
        const verdict = this.judge(output, session.pullRequestUrl);
        log.info(
          { verdict: verdict.state, prUrl: session.pullRequestUrl, status: session.rawStatus },
          'session finished',
        );
        await this.finish(r, verdict.state, {
          prUrl: verdict.prUrl ?? undefined,
          structuredOutput: output,
          acuUsed: acu,
          error: verdict.state === 'failed' ? verdict.reason : null,
        });
        return;
      }

      case 'failed':
        log.warn({ status: session.rawStatus }, 'session ended without completing');
        await this.finish(r, 'failed', {
          error: `Devin session ended: ${session.rawStatus || 'unknown status'}`,
          structuredOutput: output,
          acuUsed: acu,
        });
        return;

      case 'blocked': {
        if (r.state !== 'blocked') {
          const question = session.lastMessage;
          this.store.transition(r.id, 'blocked', { acuUsed: acu }, { question, status: session.rawStatus });
          log.info('session blocked, awaiting human input');
          await this.github.comment(
            r.issueNumber,
            [
              '### ⏸️ Devin is blocked and needs a human',
              '',
              question ? `> ${question}` : '_Devin did not provide a question._',
              '',
              `Reply in the session and Autopilot will pick the result back up: ${r.devinSessionUrl}`,
            ].join('\n'),
          );
        }
        return;
      }

      case 'running':
      default: {
        if (r.state !== 'running') {
          this.store.transition(r.id, 'running', { acuUsed: acu }, { status: session.rawStatus });
        }
        return;
      }
    }
  }

  /**
   * Turn Devin's structured output into a verdict.
   *
   * The rule that matters: "Devin said it fixed it" is not success. A claimed
   * fix with no pull request, or with failing verification, is recorded as a
   * failure. Without this check the success rate on the dashboard would
   * measure the agent's optimism rather than the system's output.
   */
  private judge(
    output: Record<string, unknown> | null,
    prUrl: string | null,
  ): { state: RemediationState; prUrl: string | null; reason: string } {
    const claimedUrl = typeof output?.pull_request_url === 'string' ? output.pull_request_url : null;
    const effectivePr = prUrl ?? claimedUrl;
    const status = typeof output?.status === 'string' ? output.status : null;
    const verified = output?.verification_passed === true;

    if (status === 'no_change_needed') {
      // A well-argued "this report was wrong" is a real, useful outcome.
      return { state: 'succeeded', prUrl: null, reason: 'no change needed' };
    }
    if (status === 'blocked') {
      return { state: 'failed', prUrl: effectivePr, reason: 'Devin reported it was blocked' };
    }
    if (!effectivePr) {
      return { state: 'failed', prUrl: null, reason: 'session finished without opening a pull request' };
    }
    if (output && !verified) {
      return { state: 'failed', prUrl: effectivePr, reason: 'verification commands did not pass' };
    }
    return { state: 'succeeded', prUrl: effectivePr, reason: 'fix verified and PR opened' };
  }

  private async finish(
    r: Remediation,
    state: RemediationState,
    patch: {
      prUrl?: string;
      structuredOutput?: unknown;
      acuUsed?: number;
      error?: string | null;
    },
  ): Promise<void> {
    const updated = this.store.transition(r.id, state, patch);

    const category = r.category ?? 'unknown';
    const severity = r.severity ?? 'unknown';
    metrics.remediationsCompleted.inc({ outcome: state, category, severity });
    if (patch.acuUsed) metrics.acuConsumed.inc({ category }, patch.acuUsed);

    const seconds = (Date.now() - new Date(r.createdAt).getTime()) / 1000;
    metrics.cycleTime.observe({ outcome: state, category }, seconds);

    await this.github.comment(r.issueNumber, this.summaryComment(updated, state, seconds));

    if (isTerminal(state)) {
      await this.github.addLabels(r.issueNumber, [`autopilot:${state}`]);
    }
  }

  private summaryComment(r: Remediation, state: RemediationState, seconds: number): string {
    const out = (r.structuredOutput ?? {}) as Record<string, unknown>;
    const icon = state === 'succeeded' ? '✅' : state === 'timed_out' ? '⏱️' : '❌';
    const mins = (seconds / 60).toFixed(1);

    const lines = [
      `### ${icon} Autopilot finished — \`${state}\``,
      '',
      `| | |`,
      `|---|---|`,
      `| Contract | \`${r.contractId ?? 'n/a'}\` |`,
      `| Cycle time | ${mins} min |`,
      `| Session | ${r.devinSessionUrl ?? 'n/a'} |`,
    ];
    if (r.prUrl) lines.push(`| Pull request | ${r.prUrl} |`);
    if (typeof out.confidence === 'string') lines.push(`| Confidence | ${out.confidence} |`);
    if (r.acuUsed) lines.push(`| ACUs | ${r.acuUsed} |`);
    lines.push('');

    if (typeof out.summary === 'string') lines.push(out.summary, '');
    if (Array.isArray(out.files_changed) && out.files_changed.length) {
      lines.push('**Files changed**', ...out.files_changed.map((f) => `- \`${String(f)}\``), '');
    }
    if (typeof out.verification_output === 'string' && out.verification_output.trim()) {
      lines.push(
        '<details><summary>Verification output</summary>',
        '',
        '```',
        out.verification_output.slice(0, 4000),
        '```',
        '',
        '</details>',
        '',
      );
    }
    if (r.error) lines.push(`**Failure reason:** ${r.error}`);

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  async tick(): Promise<void> {
    // Overlapping ticks would double-dispatch queued work; a slow Devin API is
    // exactly when that would happen, so guard rather than rely on timing.
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.reconcile();
      await this.dispatch();
      metrics.reconcilerRuns.inc({ result: 'ok' });
    } catch (err) {
      metrics.reconcilerRuns.inc({ result: 'error' });
      logger.error({ err: (err as Error).message }, 'reconciler tick failed');
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    if (this.timer) return;
    logger.info({ intervalMs: config.RECONCILE_INTERVAL_MS }, 'reconciler started');
    this.timer = setInterval(() => void this.tick(), config.RECONCILE_INTERVAL_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private get repoSlug(): string {
    return `${this.github.owner}/${this.github.repo}`;
  }
}

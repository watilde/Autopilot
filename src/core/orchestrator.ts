import { config } from '../config.js';
import type { Store } from '../db/index.js';
import { DevinApiError, type DevinClient } from '../devin/index.js';
import { parsePullRequestNumber, type GitHubClient, type IssueRef } from '../github/client.js';
import { logger } from '../logger.js';
import * as metrics from '../obs/metrics.js';
import {
  isTerminal,
  type PullRequestState,
  type Remediation,
  type RemediationState,
} from '../types.js';
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

    /**
     * Second dedup gate: an issue whose fix is already sitting in an open pull
     * request is not work, it is work awaiting review.
     *
     * The in-flight check above is not enough, and the gap is expensive. A
     * remediation that finished is terminal, but the issue it fixed stays open
     * until the PR merges — that is what `Closes #N` means. So a labelled,
     * open issue with a merge-ready PR looks exactly like fresh work to the
     * periodic scanner, and it re-dispatches on the next sweep, and the one
     * after that. This deployment paid for duplicate sessions on two issues
     * before the gate existed; Devin caught them and refused to open a second
     * PR, which is the only reason it cost ACUs rather than a mess of pull
     * requests.
     *
     * The lookup spans every attempt, not just the newest. The attempt holding
     * the pull request is usually an older one, with a cancelled duplicate
     * sitting on top of it.
     */
    const fixed = this.store.findLivePullRequestForIssue(this.repoSlug, issue.number);
    if (fixed) {
      this.store.appendEvent({
        remediationId: fixed.id,
        issueNumber: issue.number,
        type: 'intake.deduplicated',
        detail: { reason: 'open pull request', prUrl: fixed.prUrl, prState: fixed.prState },
      });
      return {
        accepted: false,
        reason:
          fixed.prState === 'merged'
            ? `already fixed and merged (${fixed.prUrl}); close the issue or remove the label`
            : `already fixed, awaiting review (${fixed.prUrl})`,
        remediation: fixed,
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

    /**
     * Last gate before spending money.
     *
     * Intake already refuses an issue with a live pull request, but a queued
     * remediation can outlive the state it was accepted in: a sibling attempt
     * may have opened a PR while this one sat in the queue, or the row may
     * predate the intake gate entirely. Checking again here costs one local
     * query; not checking costs a Devin session.
     */
    const fixed = this.store.findLivePullRequestForIssue(this.repoSlug, r.issueNumber);
    if (fixed && fixed.id !== r.id) {
      log.info({ prUrl: fixed.prUrl, by: fixed.id }, 'skipping dispatch: issue already has a pull request');
      this.store.transition(r.id, 'cancelled', {
        error: `superseded: remediation ${fixed.id} already opened ${fixed.prUrl}`,
      });
      metrics.dispatches.inc({ result: 'deduplicated', category: r.category ?? 'unknown' });
      return false;
    }

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
        playbookId: config.DEVIN_PLAYBOOK_ID,
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
  // Review-fix loop
  // -------------------------------------------------------------------------

  /**
   * Hand a CI failure back to the session that caused it.
   *
   * This is the part that makes the system worth building rather than
   * scripting. A deterministic bot's output is final: if the patch fails the
   * build, a human picks it up. Here the failing log goes back to the agent
   * that wrote the patch, with its original context intact, and it tries
   * again — the same loop a human engineer runs, minus the wait.
   *
   * Three limits keep that honest. Rework is capped, because an agent that
   * cannot fix its own build twice is stuck on something the contract did not
   * anticipate and further attempts just spend ACUs. Only Autopilot's own
   * branches are eligible. And when the cap is hit the issue is labelled for a
   * human rather than quietly abandoned — an escalation that nobody is told
   * about is the same as a failure that nobody sees.
   */
  async handleCiResult(input: {
    branch: string;
    conclusion: string;
    runId: number | null;
    runUrl: string | null;
    prUrl?: string | null;
  }): Promise<{ handled: boolean; reason: string; remediationId?: number }> {
    const r = this.findByBranchOrPr(input.branch, input.prUrl ?? null);
    if (!r) return { handled: false, reason: 'no remediation matches this branch' };

    const log = logger.child({ remediation: r.id, issue: r.issueNumber, branch: input.branch });
    const category = r.category ?? 'unknown';
    const passed = input.conclusion === 'success';

    this.store.recordCi(
      r.id,
      passed ? 'passed' : 'failed',
      { conclusion: input.conclusion, runUrl: input.runUrl },
      input.runId,
    );
    metrics.ciResults.inc({ status: passed ? 'passed' : 'failed', category });

    if (passed) {
      log.info('ci passed on remediation branch');
      return { handled: true, reason: 'ci passed', remediationId: r.id };
    }

    if (!r.devinSessionId) {
      return { handled: false, reason: 'remediation has no session to correct', remediationId: r.id };
    }

    if (r.reworks >= config.MAX_CI_REWORKS) {
      metrics.reworks.inc({ result: 'escalated', category });
      log.warn({ reworks: r.reworks }, 'ci rework cap reached, escalating to a human');
      await this.github.addLabels(r.issueNumber, ['autopilot:needs-human']);
      await this.github.comment(
        r.issueNumber,
        [
          '### 🙋 Autopilot is escalating this to a human',
          '',
          `CI has failed ${r.reworks + 1} times on \`${input.branch}\` and Devin has already been`,
          `given ${r.reworks} chance(s) to correct it. Rather than spend more ACUs on the same`,
          'loop, Autopilot has stopped and is handing this back.',
          '',
          input.runUrl ? `Failing run: ${input.runUrl}` : '',
          r.prUrl ? `Pull request: ${r.prUrl}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      return { handled: true, reason: 'rework cap reached; escalated', remediationId: r.id };
    }

    const failureLog = input.runId ? await this.github.failureLog(input.runId) : null;
    const attempt = this.store.incrementReworks(r.id);

    await this.devin.sendMessage(
      r.devinSessionId,
      [
        `CI failed on the pull request you opened for issue #${r.issueNumber}.`,
        '',
        'The verification job re-runs the same `verify` commands from the issue contract',
        'that you ran locally, so this is the contract itself failing, not a separate',
        'standard. Please diagnose the failure below, push a fix to the same branch',
        `(\`${input.branch}\`), and confirm the checks pass. Do not open a new pull request.`,
        '',
        input.runUrl ? `Failing run: ${input.runUrl}` : '',
        '',
        failureLog
          ? ['```', failureLog, '```'].join('\n')
          : '_The workflow logs could not be retrieved; check the run link above._',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );

    // Back to non-terminal: the work is genuinely in flight again, and the
    // dashboard should say so rather than reporting a success that CI rejected.
    const updated = this.store.transition(r.id, 'running', {}, {
      reason: 'ci failed; returned to devin',
      runUrl: input.runUrl,
      reworkAttempt: attempt,
    });
    metrics.reworks.inc({ result: 'sent', category });
    metrics.activeRemediations.set(this.store.countActive());

    log.info({ reworkAttempt: attempt }, 'ci failure returned to devin session');
    await this.github.comment(
      r.issueNumber,
      [
        `### 🔁 CI failed — Devin is correcting it (attempt ${attempt} of ${config.MAX_CI_REWORKS})`,
        '',
        'The contract verification job failed on the pull request. The failing output has',
        'been sent back to the same Devin session, which still has the full context of the',
        'change it made, so it can fix forward on the same branch.',
        '',
        input.runUrl ? `Failing run: ${input.runUrl}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    return { handled: true, reason: 'failure returned to devin', remediationId: updated.id };
  }

  /**
   * Map a CI event back to the remediation that caused it.
   *
   * The PR URL is authoritative when we have it. The branch is the fallback,
   * and it works because Autopilot names branches after the contract and issue
   * it dispatched — `autopilot/<contract>-issue-<n>` — so the naming convention
   * doubles as the join key when a webhook arrives before we recorded a PR.
   */
  private findByBranchOrPr(branch: string, prUrl: string | null): Remediation | null {
    if (prUrl) {
      const byPr = this.store.findByPullRequest(prUrl);
      if (byPr) return byPr;
    }
    const m = /-issue-(\d+)$/.exec(branch);
    if (!m) return null;
    return this.store.findLatestByIssue(this.repoSlug, Number(m[1]));
  }

  // -------------------------------------------------------------------------
  // Pull request outcomes
  // -------------------------------------------------------------------------

  /**
   * Ask GitHub what became of the pull requests we opened.
   *
   * Merge state arrives by webhook when one is configured, but the poll is
   * what makes the merge rate trustworthy: a webhook that was never delivered
   * and a PR that was never merged look identical from here, and only one of
   * those is acceptable to guess at. Bounded by design — it only looks at PRs
   * that have not yet reached a resting state.
   */
  /**
   * Adopt pull requests that exist but that we never recorded.
   *
   * A remediation can reach a terminal state without its PR attached — the
   * reconciler timed the session out before it exited, a poll failed at the
   * wrong moment, the process restarted mid-flight. Whatever the cause, the
   * result is the same and it is the worst kind of wrong: real, merge-ready
   * work that the dashboard reports as a failure, and an issue that looks
   * eligible for a second paid session.
   *
   * Devin is the authority on what its own session produced, so ask it. Only
   * terminal remediations with a session and no PR are considered, so this is
   * bounded and cannot fight with the live reconcile path.
   */
  async adoptOrphanedPullRequests(): Promise<number> {
    let adopted = 0;

    for (const r of this.store.listTerminalWithoutPullRequest()) {
      let session;
      try {
        session = await this.devin.getSession(r.devinSessionId!);
      } catch (err) {
        logger.debug(
          { remediation: r.id, err: (err as Error).message },
          'could not re-read session while looking for an orphaned pull request',
        );
        continue; // No stamp: a transport failure is not an answer.
      }

      this.store.markPullRequestChecked(r.id);

      const verdict = this.judge(session.structuredOutput, session.pullRequestUrl);
      if (!verdict.prUrl) continue;

      this.store.transition(r.id, verdict.state, {
        prUrl: verdict.prUrl,
        structuredOutput: session.structuredOutput ?? undefined,
        acuUsed: session.acuUsed ?? undefined,
        error: verdict.state === 'succeeded' ? null : verdict.reason,
      }, { adopted: true, previousState: r.state, reason: 'pull request found on the session' });

      this.store.recordPullRequest(r.id, { url: verdict.prUrl, state: 'open' });
      metrics.pullRequests.inc({ state: 'open', category: r.category ?? 'unknown' });
      adopted++;

      logger.info(
        { remediation: r.id, issue: r.issueNumber, prUrl: verdict.prUrl, was: r.state },
        'adopted a pull request the session had already opened',
      );
      await this.github.comment(
        r.issueNumber,
        [
          '### 🔎 Autopilot corrected its own record',
          '',
          `This remediation was recorded as \`${r.state}\`, but the Devin session had already`,
          `opened ${verdict.prUrl}. The state has been corrected to \`${verdict.state}\` and the`,
          'pull request is now tracked.',
        ].join('\n'),
      );
    }
    return adopted;
  }

  async syncPullRequests(): Promise<number> {
    if (!this.github.enabled) return 0;
    let changed = 0;

    for (const r of this.store.listAwaitingPullRequestOutcome()) {
      const number = parsePullRequestNumber(r.prUrl);
      if (!number) continue;

      const pr = await this.github.getPullRequest(number);
      if (!pr || pr.state === r.prState) continue;

      this.store.recordPullRequest(r.id, { url: pr.url, state: pr.state, mergedAt: pr.mergedAt });
      metrics.pullRequests.inc({ state: pr.state, category: r.category ?? 'unknown' });
      changed++;

      logger.info({ remediation: r.id, pr: number, state: pr.state }, 'pull request outcome recorded');
      if (pr.state === 'merged') {
        await this.github.comment(
          r.issueNumber,
          `### 🚢 Shipped\n\nPull request ${pr.url} was merged. This remediation is complete end to end.`,
        );
      }
    }
    return changed;
  }

  /**
   * Poll CI for the branches we own, and feed any new verdict into the loop.
   *
   * The `workflow_run` webhook does the same job with less latency, but only
   * where GitHub can reach this service. Requiring a public tunnel to have a
   * working review-fix loop would make the most valuable behaviour in the
   * system the one that only works in a particular deployment, so the poll is
   * the floor and the webhook is the optimisation.
   *
   * Keyed on run id, not status: two consecutive failures both read `failed`,
   * and telling them apart is the difference between a second correction and
   * an infinite resend of the first.
   */
  async syncCiStatus(): Promise<number> {
    if (!this.github.enabled) return 0;
    let handled = 0;

    for (const r of this.store.listAwaitingPullRequestOutcome()) {
      const branch = this.branchOf(r);
      if (!branch) continue;

      const run = await this.github.latestWorkflowRun(branch);
      if (!run || run.status !== 'completed' || !run.conclusion) continue;
      if (run.id === r.ciRunId) continue; // already accounted for
      // Cancelled and skipped runs are not verdicts on the change.
      if (run.conclusion !== 'success' && run.conclusion !== 'failure') continue;

      await this.handleCiResult({
        branch,
        conclusion: run.conclusion,
        runId: run.id,
        runUrl: run.htmlUrl,
        prUrl: r.prUrl,
      });
      handled++;
    }
    return handled;
  }

  /**
   * The branch a remediation owns. Reconstructed from the contract and issue
   * rather than stored, because it is the same deterministic name the prompt
   * told Devin to use — one definition, in `branchFor`.
   */
  private branchOf(r: Remediation): string | null {
    if (!r.contractId) return null;
    return `autopilot/${r.contractId.toLowerCase()}-issue-${r.issueNumber}`;
  }

  /** Webhook path for the same information, so a merge shows up immediately. */
  recordPullRequestEvent(input: {
    url: string;
    state: PullRequestState;
    mergedAt: string | null;
    branch: string;
  }): Remediation | null {
    const r = this.findByBranchOrPr(input.branch, input.url);
    if (!r) return null;
    const updated = this.store.recordPullRequest(r.id, {
      url: input.url,
      state: input.state,
      mergedAt: input.mergedAt,
    });
    metrics.pullRequests.inc({ state: input.state, category: r.category ?? 'unknown' });
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

    // Normalised by the client, so this switch is identical for v1 and v3.
    const session = await this.devin.getSession(r.devinSessionId!);
    const acu = session.acuUsed ?? undefined;
    const output = session.structuredOutput;

    /**
     * Record the pull request the moment it exists, whatever state the session
     * is in.
     *
     * A session does not have to be finished to have delivered. The common
     * shape is the opposite: Devin opens the PR, then stops to ask whether
     * anything else is wanted, and sits in `blocked` — with merge-ready work
     * already on the board. Waiting for a terminal state to notice that leaves
     * the PR invisible to the dashboard, missing from merge rate, and, worst,
     * invisible to the dedup gate, which is what lets the scanner dispatch a
     * second paid session for work that is already done.
     */
    if (session.pullRequestUrl && !r.prUrl) {
      this.store.recordPullRequest(r.id, { url: session.pullRequestUrl, state: 'open' });
      metrics.pullRequests.inc({ state: 'open', category: r.category ?? 'unknown' });
      log.info({ prUrl: session.pullRequestUrl, state: r.state }, 'pull request opened by session');
    }

    /**
     * The timeout is checked *after* asking what the session actually did.
     *
     * The obvious order — clock first, then state — is wrong, and wrong in the
     * expensive direction. A Devin session does not exit the moment it opens a
     * pull request; it can sit idle afterwards. Checking the clock first
     * therefore lets the reconciler kill a session that already delivered,
     * record it as `timed_out`, and hand a retry a second paid session for work
     * that was already done. That is exactly what happened to remediations 1
     * and 2 of this deployment: two merge-ready pull requests recorded as
     * timeouts, and two duplicate sessions opened behind them.
     *
     * So evidence outranks the clock: if the work exists, judge it. The timeout
     * still exists for its real purpose, which is a session that produced
     * nothing and will not stop on its own.
     */
    const ageMs = Date.now() - new Date(r.createdAt).getTime();
    if (ageMs > config.SESSION_TIMEOUT_MS && session.state !== 'finished') {
      const verdict = this.judge(output, session.pullRequestUrl);
      const delivered = Boolean(verdict.prUrl);

      log.warn({ ageMs, delivered }, 'remediation exceeded its time budget');
      await this.finish(r, delivered ? verdict.state : 'timed_out', {
        prUrl: verdict.prUrl ?? undefined,
        structuredOutput: output ?? undefined,
        acuUsed: acu,
        error: delivered
          ? `session outlived ${config.SESSION_TIMEOUT_MS}ms but had already opened a pull request`
          : `exceeded ${config.SESSION_TIMEOUT_MS}ms`,
      });
      try {
        await this.devin.terminateSession(r.devinSessionId!);
      } catch {
        // Best effort — the remediation is already recorded either way.
      }
      return;
    }

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
    let updated = this.store.transition(r.id, state, patch);

    // Stamp when the pull request first existed. Time-to-fix ends here, not at
    // whatever the reconciler happened to notice afterwards.
    if (patch.prUrl && !updated.prOpenedAt) {
      updated = this.store.recordPullRequest(r.id, { url: patch.prUrl, state: 'open' });
      metrics.pullRequests.inc({ state: 'open', category: r.category ?? 'unknown' });
    }

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
      await this.adoptOrphanedPullRequests();
      await this.syncPullRequests();
      await this.syncCiStatus();
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

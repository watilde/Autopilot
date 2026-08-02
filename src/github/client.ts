import { Octokit } from '@octokit/rest';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { PullRequestState } from '../types.js';

/**
 * Everything Autopilot needs from GitHub, and nothing else.
 *
 * Note what is absent: this client never pushes code and never opens pull
 * requests. Devin does that through its own GitHub integration. Autopilot only
 * reads issues and writes status back, which keeps the token it needs small
 * and makes the trust boundary easy to describe in review.
 */

export interface IssueRef {
  number: number;
  title: string;
  body: string | null;
  htmlUrl: string;
  labels: string[];
  state: string;
}

export interface PullRequestSnapshot {
  number: number;
  url: string;
  state: PullRequestState;
  mergedAt: string | null;
  headRef: string;
  headSha: string;
}

/**
 * Pull the PR number out of a `.../pull/123` URL.
 *
 * Devin reports the pull request it opened as a URL, and GitHub's API wants a
 * number, so this conversion sits between "what the agent told us" and every
 * subsequent question we ask about that PR.
 */
export function parsePullRequestNumber(url: string | null): number | null {
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url ?? '');
  return m ? Number(m[1]) : null;
}

export class GitHubClient {
  private octokit: Octokit | null;
  readonly owner: string;
  readonly repo: string;

  constructor(token: string | undefined, owner: string, repo: string) {
    this.owner = owner;
    this.repo = repo;
    this.octokit = token ? new Octokit({ auth: token }) : null;
    if (!this.octokit) {
      logger.warn('github client: no token, running read-less (mock/demo mode)');
    }
  }

  get enabled(): boolean {
    return this.octokit !== null;
  }

  async getIssue(number: number): Promise<IssueRef | null> {
    if (!this.octokit) return null;
    try {
      const { data } = await this.octokit.issues.get({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
      });
      return {
        number: data.number,
        title: data.title,
        body: data.body ?? null,
        htmlUrl: data.html_url,
        labels: (data.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
        state: data.state,
      };
    } catch (err) {
      logger.error({ number, err: (err as Error).message }, 'failed to fetch issue');
      return null;
    }
  }

  async listIssuesByLabel(label: string): Promise<IssueRef[]> {
    if (!this.octokit) return [];
    const { data } = await this.octokit.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      labels: label,
      state: 'open',
      per_page: 100,
    });
    return data
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? null,
        htmlUrl: i.html_url,
        labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
        state: i.state,
      }));
  }

  /**
   * Status comments are the human-visible half of observability: the dashboard
   * is for the team, the issue thread is for whoever filed the bug.
   */
  async comment(issueNumber: number, body: string): Promise<void> {
    if (!this.octokit || !config.POST_ISSUE_COMMENTS) return;
    try {
      await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body,
      });
    } catch (err) {
      // Never let a failed comment take down a remediation that is otherwise
      // progressing — this is reporting, not control flow.
      logger.warn({ issueNumber, err: (err as Error).message }, 'failed to post issue comment');
    }
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (!this.octokit) return;
    try {
      await this.octokit.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        labels,
      });
    } catch (err) {
      logger.warn({ issueNumber, err: (err as Error).message }, 'failed to add labels');
    }
  }

  /**
   * Current state of a pull request.
   *
   * "Devin opened a PR" and "the fix shipped" are different claims, and only
   * GitHub can settle the second one. Merge rate is the metric an engineering
   * leader actually cares about, so it has to come from here rather than from
   * anything the agent reported about itself.
   */
  async getPullRequest(number: number): Promise<PullRequestSnapshot | null> {
    if (!this.octokit) return null;
    try {
      const { data } = await this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: number,
      });
      return {
        number: data.number,
        url: data.html_url,
        state: data.merged_at ? 'merged' : (data.state as 'open' | 'closed'),
        mergedAt: data.merged_at ?? null,
        headRef: data.head.ref,
        headSha: data.head.sha,
      };
    } catch (err) {
      logger.warn({ number, err: (err as Error).message }, 'failed to fetch pull request');
      return null;
    }
  }

  /** The open PR for a branch, if Devin opened one and we lost track of the URL. */
  async findPullRequestForBranch(branch: string): Promise<PullRequestSnapshot | null> {
    if (!this.octokit) return null;
    try {
      const { data } = await this.octokit.pulls.list({
        owner: this.owner,
        repo: this.repo,
        head: `${this.owner}:${branch}`,
        state: 'all',
        per_page: 1,
        sort: 'created',
        direction: 'desc',
      });
      const pr = data[0];
      if (!pr) return null;
      return {
        number: pr.number,
        url: pr.html_url,
        state: pr.merged_at ? 'merged' : (pr.state as 'open' | 'closed'),
        mergedAt: pr.merged_at ?? null,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
      };
    } catch (err) {
      logger.warn({ branch, err: (err as Error).message }, 'failed to look up pull request');
      return null;
    }
  }

  /**
   * The most recent completed workflow run for a branch.
   *
   * The webhook tells us this faster, but only when one is configured and
   * reachable. Polling is what makes the review-fix loop work on a laptop
   * behind NAT, and — as with merge state — a webhook that was never delivered
   * is indistinguishable from a build that passed, which is not a thing to
   * guess about.
   */
  async latestWorkflowRun(branch: string): Promise<{
    id: number;
    conclusion: string | null;
    status: string;
    htmlUrl: string;
    headSha: string;
  } | null> {
    if (!this.octokit) return null;
    try {
      const { data } = await this.octokit.actions.listWorkflowRunsForRepo({
        owner: this.owner,
        repo: this.repo,
        branch,
        per_page: 1,
      });
      const run = data.workflow_runs[0];
      if (!run) return null;
      return {
        id: run.id,
        conclusion: run.conclusion ?? null,
        status: run.status ?? 'unknown',
        htmlUrl: run.html_url,
        headSha: run.head_sha,
      };
    } catch (err) {
      logger.warn({ branch, err: (err as Error).message }, 'failed to list workflow runs');
      return null;
    }
  }

  /**
   * The tail of the logs from the failed jobs in a workflow run.
   *
   * This is what makes a review-fix loop possible: to correct itself, Devin
   * needs the actual failure text, not "CI failed". The tail is taken rather
   * than the head because a build log is mostly setup noise and the part that
   * explains the failure is at the end — and because whatever is sent lands in
   * the session's context window, which is not free.
   */
  async failureLog(runId: number, maxChars = 6000): Promise<string | null> {
    if (!this.octokit) return null;
    try {
      const { data: jobs } = await this.octokit.actions.listJobsForWorkflowRun({
        owner: this.owner,
        repo: this.repo,
        run_id: runId,
        filter: 'latest',
      });

      const failed = jobs.jobs.filter((j) => j.conclusion === 'failure');
      if (!failed.length) return null;

      const chunks: string[] = [];
      for (const job of failed.slice(0, 2)) {
        const res = await this.octokit.actions.downloadJobLogsForWorkflowRun({
          owner: this.owner,
          repo: this.repo,
          job_id: job.id,
        });
        const text = typeof res.data === 'string' ? res.data : Buffer.from(res.data as ArrayBuffer).toString('utf8');
        chunks.push(`--- job: ${job.name} ---\n${text.slice(-maxChars)}`);
      }
      return chunks.join('\n\n').slice(-maxChars * 2);
    } catch (err) {
      logger.warn({ runId, err: (err as Error).message }, 'failed to download workflow logs');
      return null;
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    if (!this.octokit) return;
    try {
      await this.octokit.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        name: label,
      });
    } catch (err) {
      // 404 just means the label was not there; not worth logging loudly.
      logger.debug({ issueNumber, err: (err as Error).message }, 'failed to remove label');
    }
  }
}

export function createGitHubClient(): GitHubClient {
  return new GitHubClient(config.GITHUB_TOKEN, config.GITHUB_OWNER, config.GITHUB_REPO);
}

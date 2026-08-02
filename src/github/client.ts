import { Octokit } from '@octokit/rest';
import { config } from '../config.js';
import { logger } from '../logger.js';

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

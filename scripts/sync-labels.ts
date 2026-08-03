import { config } from '../src/config.js';
import { Store } from '../src/db/index.js';
import { createDevinClient } from '../src/devin/index.js';
import { GitHubClient } from '../src/github/client.js';
import { Orchestrator } from '../src/core/orchestrator.js';

/**
 * Make the issue labels agree with the record.
 *
 * A repair, not a loop. The write paths keep labels true going forward, but two
 * things put them out of step: outcomes recorded before those paths *set* the
 * label rather than adding to it, and `addLabels` swallowing its own failures —
 * it logs and returns, because a label is reporting and must never take down a
 * remediation that is otherwise progressing. Neither heals on its own, and a
 * per-issue read on every reconciler pass would be a standing API cost forever
 * to catch something rare.
 *
 * Run it when the dashboard and the issue thread disagree:
 *
 *   npm run labels:sync
 */

const store = new Store(config.DATABASE_PATH);
const orchestrator = new Orchestrator(
  store,
  createDevinClient(),
  new GitHubClient(config.GITHUB_TOKEN, config.GITHUB_OWNER, config.GITHUB_REPO),
);

const fixed = await orchestrator.reconcileIssueLabels();
console.log(fixed === 0 ? '\n  labels already agree with the record\n' : `\n  corrected ${fixed} issue(s)\n`);

store.close();

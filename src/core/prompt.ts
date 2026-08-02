import type { RemediationContract } from '../types.js';
import { branchFor } from './contract.js';

/**
 * Prompt construction is where a demo becomes a system.
 *
 * The prompt is assembled deterministically from the issue's contract rather
 * than hand-written per task, which means: every session gets the same rules,
 * scope is bounded explicitly, and "done" is defined by commands that either
 * exit 0 or do not. Devin is asked to run those commands itself and report the
 * result, so a PR arrives with evidence attached instead of a claim.
 */

export interface PromptInput {
  owner: string;
  repo: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  contract: RemediationContract;
}

export function buildPrompt(input: PromptInput): string {
  const { owner, repo, issueNumber, issueTitle, issueUrl, contract } = input;
  const branch = branchFor(contract, issueNumber);
  const repoSlug = `${owner}/${repo}`;

  const targets = contract.targets.map((t) => `  - ${t}`).join('\n');
  const acceptance = contract.acceptance.map((a, i) => `  ${i + 1}. ${a}`).join('\n');
  const verify = contract.verify.map((c) => `  $ ${c}`).join('\n');

  return `You are remediating a single, well-scoped defect in the repository ${repoSlug}.

# Source of truth
GitHub issue #${issueNumber}: ${issueTitle}
${issueUrl}
Remediation contract: ${contract.id} (${contract.category}, severity ${contract.severity})

# Where the defect lives
${targets}

# What "fixed" means
${acceptance}

# How to prove it
Run every one of these in the repository root. All must exit 0 before you open
a pull request. Paste their real output into your structured result — do not
summarise or predict it.
${verify}

# Procedure
1. Clone ${repoSlug} and create branch \`${branch}\` from the default branch.
2. Read the target files before editing. Confirm the defect is actually present
   and still matches the description. Line numbers may have drifted; locate the
   code by content, not by line number.
3. If the defect is NOT present, or the report is wrong, make no code changes.
   Return status "no_change_needed" and explain what you found. Reporting a
   false positive is a correct and valuable outcome — do not invent a change to
   look productive.
4. Apply the minimal fix that satisfies every acceptance criterion.
5. Run the verification commands. If any fails, fix your change and re-run.
   If you cannot make them pass, return status "blocked" and explain why.
6. Match the surrounding code's style. Do not reformat untouched lines, bump
   unrelated dependencies, or "improve" adjacent code.
7. Open a pull request from \`${branch}\` against the default branch. Title it
   \`[${contract.id}] ${issueTitle}\`. In the body, explain the root cause, the
   fix, and the verification output, and include the line \`Closes #${issueNumber}\`.

# Scope limits
- Touch only what the contract requires. This PR must be reviewable in minutes.
- Do not modify CI configuration, licence headers, or unrelated tests.
- Do not force-push to or delete any branch you did not create.
- If the fix would require a breaking API change, stop and return "blocked".
${contract.notes ? `\n# Additional context\n${contract.notes}\n` : ''}
# Reporting
When you are done, populate the structured output schema exactly. \`pull_request_url\`
must be the real URL of the PR you opened, or null if you opened none.`;
}

/**
 * Forcing a JSON Schema on the result is what lets the orchestrator decide
 * success programmatically. Without it we would be regex-matching prose to
 * find out whether a PR exists.
 */
export const REMEDIATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: [
    'status',
    'summary',
    'files_changed',
    'verification_passed',
    'verification_output',
    'pull_request_url',
    'confidence',
  ],
  properties: {
    status: {
      type: 'string',
      enum: ['fixed', 'no_change_needed', 'blocked'],
      description: 'fixed = code changed and PR opened; no_change_needed = report was a false positive; blocked = could not complete',
    },
    summary: { type: 'string', description: 'Root cause and the fix, in two or three sentences.' },
    files_changed: {
      type: 'array',
      items: { type: 'string' },
      description: 'Repository-relative paths actually modified.',
    },
    verification_passed: {
      type: 'boolean',
      description: 'True only if every verification command exited 0.',
    },
    verification_output: {
      type: 'string',
      description: 'Real captured output of the verification commands.',
    },
    pull_request_url: {
      type: ['string', 'null'],
      description: 'URL of the opened PR, or null if none was opened.',
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

export function sessionTitle(contract: RemediationContract, issueNumber: number): string {
  return `[Autopilot] ${contract.id} — issue #${issueNumber}`;
}

export function sessionTags(contract: RemediationContract, issueNumber: number): string[] {
  return [
    'autopilot',
    `contract:${contract.id}`,
    `issue:${issueNumber}`,
    `category:${contract.category}`,
    `severity:${contract.severity}`,
  ];
}

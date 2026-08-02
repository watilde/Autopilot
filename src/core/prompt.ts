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

/**
 * The standing half of the instructions, held on Devin's side as a playbook.
 *
 * Every remediation session shares these rules; only the contract changes. Two
 * reasons that is worth a playbook rather than more prompt text: the procedure
 * can be revised in the Devin UI by someone who is not deploying this service,
 * and a session in the dashboard shows which playbook it ran under, so the
 * behaviour of a run is attributable to a named, versioned document instead of
 * to whatever string a process happened to build that day.
 *
 * The per-session prompt still carries these rules verbatim, so a deployment
 * with no playbook configured behaves identically. This is reinforcement, not
 * a dependency.
 */
export const REMEDIATION_PLAYBOOK = {
  title: 'Autopilot — contract-bounded remediation',
  body: `You are remediating a single, well-scoped defect described by a machine-readable
remediation contract. The session prompt carries the contract; this playbook
carries the rules that are the same every time.

# Procedure
1. Create the branch named in the prompt from the default branch. Never commit
   to the default branch.
2. Read the target files before editing. Line numbers in a contract drift —
   locate the code by content. Confirm the defect is actually present.
3. If the defect is not present, or the report is wrong, change nothing and
   return status "no_change_needed" with what you found. A well-argued false
   positive is a successful outcome; inventing a change to look productive is
   not.
4. Apply the minimal fix that satisfies every acceptance criterion.
5. Run every verification command from the contract in the repository root.
   All must exit 0 before you open a pull request. Paste their real output into
   the structured result — never summarise or predict it.
6. Open one pull request, with the root cause, the fix, the verification output,
   and \`Closes #<issue>\` in the body.

# Scope limits
- Touch only what the contract requires. The PR must be reviewable in minutes.
- Do not reformat untouched lines, bump unrelated dependencies, or improve
  adjacent code.
- Do not modify CI configuration, licence headers, or unrelated tests.
- Do not force-push to or delete a branch you did not create.
- If the fix would require a breaking API change, stop and return "blocked".

# If CI fails after you open the pull request
The failing output will be sent back to this session. The verification job runs
the same contract commands you ran, so a failure there is the contract failing.
Fix forward on the same branch — do not open a second pull request.`,
};

/**
 * Prompt for the scheduled audit sweep.
 *
 * The rest of this system starts at "a human labelled an issue". That leaves
 * the hardest part — noticing the defect at all — as manual work, which is
 * exactly the work that loses to feature delivery. A scheduled session closes
 * that gap: Devin reads the repository on a cadence and files issues that are
 * already dispatchable, so the backlog refills itself and Autopilot's intake
 * gate (a valid contract, or no session) still decides what actually runs.
 */
export function auditPrompt(owner: string, repo: string, label: string): string {
  return `Audit the repository ${owner}/${repo} for defects that can be safely remediated
by an autonomous agent, and file them as GitHub issues.

# What to look for
Prefer defects with a clear root cause and a mechanical, verifiable fix:
- security defects (unsafe deserialization, weak hashing used as a primitive,
  injection-prone string building, secrets in code)
- correctness bugs that are latent rather than reported (unchecked assumptions,
  collision-prone identifier generation, incorrect error handling)
- reliability and compatibility problems (crashes under a supported
  configuration, deprecated APIs scheduled for removal)
- dependency debt where the *investigation* is the work, not the version bump

Skip anything that needs a product decision, a breaking API change, or a
judgement call about intent. Those are not agent work.

# Before filing
Search existing open issues first. Do not file a duplicate, and do not re-file
something that was closed as wontfix. If you find nothing worth filing, say so
and file nothing — an empty audit is a legitimate result.

# How to file
Open at most 3 issues, most severe first. Each one must:
- explain the defect, why it matters, and its blast radius, in prose a reviewer
  who has never seen the file can follow
- label the issue \`${label}\`
- end with a fenced \`autopilot\` block carrying the remediation contract:

\`\`\`autopilot
id: <AREA>-<NNN>          # e.g. SEC-014, QUAL-007
category: security | dependency | code-quality | reliability | other
severity: critical | high | medium | low
targets:
  - path/to/file.ext:line
acceptance:
  - "Plain-language condition the diff must satisfy"
verify:
  - "shell command that exits 0 only when the fix is correct"
notes: |
  Anything that bounds the scope of the fix.
\`\`\`

The verify commands are the important part: they are re-run against the pull
request by CI, so they must be real, runnable, and specific enough that they
would fail on the unfixed code. Check that they do.`;
}

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

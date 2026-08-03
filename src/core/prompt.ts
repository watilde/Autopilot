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
  /**
   * Branch the pull request is opened against. Omitted means the repository's
   * default branch — the right answer in a real repository, and the one thing
   * Devin's tooling will not merge into.
   */
  baseBranch?: string | null;
}

export function buildPrompt(input: PromptInput): string {
  const { owner, repo, issueNumber, issueTitle, issueUrl, contract } = input;
  const branch = branchFor(contract, issueNumber);
  const repoSlug = `${owner}/${repo}`;
  // Named explicitly when configured, so the instruction is unambiguous rather
  // than a phrase the session has to resolve against the repository.
  const base = input.baseBranch ? `\`${input.baseBranch}\`` : 'the default branch';

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
1. Clone ${repoSlug} and create branch \`${branch}\` from ${base}.
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
7. Open a pull request from \`${branch}\` against ${base}. Title it
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

/**
 * Prompt for the reviewing session.
 *
 * A different session from the one that wrote the code, deliberately. It never
 * saw the change being made, and it is given the contract and the diff — which
 * is the position a human reviewer is in, and the only position from which
 * "this satisfies the commands but misses the point" is a thing you can say.
 *
 * It reviews on GitHub rather than reporting back here, and that is the whole
 * design: submitting a `pull_request_review` puts the verdict where the pull
 * request is, visible to anyone reading it, and Autopilot picks it up through
 * the same webhook a person's review arrives on. There is no privileged
 * channel for the agent's opinion.
 *
 * The scope limits matter more here than anywhere else. A reviewer that starts
 * editing is no longer a reviewer, and a reviewer that approves its own
 * provider's work on vibes is worse than none — so it is told what CI already
 * covers, and asked not to re-litigate it.
 */
export function reviewPrompt(input: {
  owner: string;
  repo: string;
  issueNumber: number;
  issueUrl: string;
  prUrl: string;
  contract: RemediationContract;
}): string {
  const { owner, repo, issueNumber, issueUrl, prUrl, contract } = input;
  const acceptance = contract.acceptance.map((a, i) => `  ${i + 1}. ${a}`).join('\n');
  const targets = contract.targets.map((t) => `  - ${t}`).join('\n');

  return `Review a pull request opened by another agent against the contract it was given,
and submit your review on GitHub.

# What you are reviewing
${prUrl}
It closes issue #${issueNumber} in ${owner}/${repo}: ${issueUrl}

You did not write this change and you have no context on it beyond what is in
the pull request. That is intentional. Read the diff.

# The contract it was held to
Contract ${contract.id} — ${contract.category}, severity ${contract.severity}

Files it was allowed to touch:
${targets}

What "fixed" was defined as:
${acceptance}

# What CI has already checked, and you should not re-check
A verification job has already re-run every \`verify\` command from the issue on
this pull request, and they passed. Do not re-run them, do not comment on
whether the tests pass, and do not ask for more tests unless their absence is
the defect. That question is answered.

# What only a reviewer can check
1. **Scope.** Does the diff stay inside the files the contract named? Changes to
   anything else are a problem even if they are improvements.
2. **The point.** Does the change actually address the defect described in the
   issue, or does it satisfy the verification commands while leaving the defect
   intact? This is the failure the commands cannot catch.
3. **Duplication.** Does it re-implement something the repository already has?
4. **Blast radius.** Does it change behaviour the issue did not ask to change —
   a public signature, a default, an error type callers may depend on?
5. **Legibility.** Would a maintainer reading this in six months understand why
   it is written this way?

# How to submit the review
Use the GitHub CLI, on the pull request above.

- If it is sound, approve it:
  \`gh pr review ${prUrl} --approve --body "<what you checked, in two or three sentences>"\`
- If it needs changes, request them:
  \`gh pr review ${prUrl} --request-changes --body "<what is wrong and what would fix it>"\`

Be specific in the body. The author is another agent and your body is the entire
instruction it will act on — "this could be cleaner" is not actionable, "this
duplicates make_id() in superset/utils/core.py; call that instead" is.

Request changes only for something in the list above. A preference about style
that the surrounding code does not already enforce is not a reason to send work
back — every round trip costs money, and a reviewer that cannot be satisfied is
a worse failure than a change that was merely fine.

# Hard limits
- Do NOT push commits, edit files, or open a pull request of your own. You are
  reviewing.
- Do NOT merge, close, or reopen anything.
- Do NOT approve without reading the diff. If you cannot see the diff, say so in
  a \`--comment\` review and stop; a review you could not perform must not look
  like one you did.`;
}

/** What the reviewing session reports back, so the verdict is data as well as a GitHub review. */
export const REVIEW_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['verdict', 'summary', 'submitted'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['approved', 'changes_requested', 'could_not_review'],
      description: 'The review that was submitted on the pull request.',
    },
    summary: {
      type: 'string',
      description: 'What was checked and what was found, in two or three sentences.',
    },
    submitted: {
      type: 'boolean',
      description: 'True only if `gh pr review` actually succeeded. Never true on intent alone.',
    },
    concerns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Specific, actionable problems. Empty when approving.',
    },
    out_of_scope_files: {
      type: 'array',
      items: { type: 'string' },
      description: 'Files the diff touched that the contract did not name.',
    },
  },
};

/** What the audit session reports: what it filed, and what it decided not to. */
export const AUDIT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['issues_filed', 'summary'],
  properties: {
    issues_filed: {
      type: 'array',
      description: 'Issues actually opened. Empty is a legitimate result.',
      items: {
        type: 'object',
        properties: {
          number: { type: ['integer', 'null'] },
          url: { type: 'string' },
          contract_id: { type: 'string' },
          category: { type: 'string' },
          title: { type: 'string' },
        },
      },
    },
    considered_and_rejected: {
      type: 'array',
      items: { type: 'string' },
      description: 'Defects found but not filed, and why — needed a product decision, already reported, not mechanically verifiable.',
    },
    summary: { type: 'string' },
  },
};

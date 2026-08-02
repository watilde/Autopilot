/**
 * Domain vocabulary shared by the dispatcher, the reconciler and the
 * analytics layer. Keeping the state machine in one place is what lets the
 * dashboard describe progress without re-deriving it from Devin's API.
 */

export const REMEDIATION_STATES = [
  'queued', // accepted from a trigger, not yet sent to Devin
  'dispatching', // creating the Devin session
  'running', // Devin is working
  'blocked', // Devin needs input from a human
  'succeeded', // terminal: Devin finished and opened a PR
  'failed', // terminal: Devin errored, or finished without satisfying the contract
  'timed_out', // terminal: exceeded SESSION_TIMEOUT_MS
  'cancelled', // terminal: operator or label removal stopped it
] as const;

export type RemediationState = (typeof REMEDIATION_STATES)[number];

export const TERMINAL_STATES: readonly RemediationState[] = [
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
];

export const isTerminal = (s: RemediationState): boolean => TERMINAL_STATES.includes(s);

export type Category = 'security' | 'dependency' | 'code-quality' | 'reliability' | 'other';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

/**
 * What happened to the pull request after Devin opened it.
 *
 * Tracked separately from the remediation state because they answer different
 * questions. `succeeded` means the agent did its job; `merged` means the
 * organisation accepted the result. Only the second one is value delivered,
 * and a system that reports the first as if it were the second is flattering
 * itself.
 */
export type PullRequestState = 'open' | 'merged' | 'closed';

/** Verdict from the PR's own CI, which is the check Autopilot does not control. */
export type CiStatus = 'pending' | 'passed' | 'failed';

/**
 * The machine-readable half of a GitHub issue. Authors write this as a fenced
 * ```autopilot block in the issue body; Autopilot refuses to dispatch without
 * one. It is the contract between "a human described a problem" and "an agent
 * is allowed to change code", and it is what makes success automatically
 * checkable instead of a judgement call.
 */
export interface RemediationContract {
  /** Stable human ID, e.g. SEC-001. Used in branch names and reports. */
  id: string;
  category: Category;
  severity: Severity;
  /** `path/to/file.py:123` locations the fix is expected to touch. */
  targets: string[];
  /** Plain-language conditions the diff must satisfy. */
  acceptance: string[];
  /** Shell commands that must exit 0 in the repo before Devin opens the PR. */
  verify: string[];
  /** Optional branch name override. */
  branch?: string;
  /** Free-form extra guidance passed through to the prompt. */
  notes?: string;
}

export interface Remediation {
  id: number;
  repo: string;
  issueNumber: number;
  issueUrl: string;
  title: string;
  contractId: string | null;
  category: string | null;
  severity: string | null;
  state: RemediationState;
  devinSessionId: string | null;
  devinSessionUrl: string | null;
  prUrl: string | null;
  prState: PullRequestState | null;
  /** When the PR first appeared — the numerator of time-to-fix. */
  prOpenedAt: string | null;
  prMergedAt: string | null;
  ciStatus: CiStatus | null;
  /** Which run produced `ciStatus`, so a second failure is not mistaken for the first. */
  ciRunId: number | null;
  /** How many times CI sent this back to Devin for a self-correction. */
  reworks: number;
  structuredOutput: unknown | null;
  attempt: number;
  error: string | null;
  acuUsed: number | null;
  triggeredBy: string;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface AutopilotEvent {
  id: number;
  remediationId: number | null;
  issueNumber: number | null;
  type: string;
  fromState: string | null;
  toState: string | null;
  detail: unknown;
  createdAt: string;
}

/** What we force Devin to return, so completion is data rather than prose. */
export interface DevinRemediationResult {
  status: 'fixed' | 'no_change_needed' | 'blocked';
  summary: string;
  files_changed: string[];
  verification_passed: boolean;
  verification_output: string;
  pull_request_url: string | null;
  confidence: 'high' | 'medium' | 'low';
}

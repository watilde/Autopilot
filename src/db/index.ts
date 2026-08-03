import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AutopilotEvent,
  CiStatus,
  PullRequestState,
  Remediation,
  RemediationState,
} from '../types.js';

/**
 * Persistence is deliberately boring: one SQLite file, no ORM.
 *
 * Two tables carry the whole system. `remediations` is current state (one row
 * per issue attempt); `events` is an append-only transition log. Every metric
 * the dashboard shows is derived from `events`, which means the numbers are
 * reconstructible after a restart and auditable after an incident — you can
 * always answer "what did this thing do, and when".
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS remediations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  repo               TEXT    NOT NULL,
  issue_number       INTEGER NOT NULL,
  issue_url          TEXT    NOT NULL DEFAULT '',
  title              TEXT    NOT NULL,
  contract_id        TEXT,
  category           TEXT,
  severity           TEXT,
  state              TEXT    NOT NULL,
  devin_session_id   TEXT,
  devin_session_url  TEXT,
  pr_url             TEXT,
  pr_state           TEXT,
  pr_opened_at       TEXT,
  pr_merged_at       TEXT,
  ci_status          TEXT,
  reworks            INTEGER NOT NULL DEFAULT 0,
  merge_requested_at TEXT,
  merge_escalated_at TEXT,
  structured_output  TEXT,
  attempt            INTEGER NOT NULL DEFAULT 1,
  error              TEXT,
  acu_used           REAL,
  triggered_by       TEXT    NOT NULL DEFAULT 'unknown',
  created_at         TEXT    NOT NULL,
  dispatched_at      TEXT,
  completed_at       TEXT,
  updated_at         TEXT    NOT NULL,
  UNIQUE (repo, issue_number, attempt)
);

CREATE INDEX IF NOT EXISTS idx_remediations_state ON remediations(state);
CREATE INDEX IF NOT EXISTS idx_remediations_session ON remediations(devin_session_id);

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  remediation_id INTEGER,
  issue_number   INTEGER,
  type           TEXT NOT NULL,
  from_state     TEXT,
  to_state       TEXT,
  detail         TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_remediation ON events(remediation_id);

-- GitHub retries webhook deliveries. Recording the delivery UUID lets us make
-- ingestion idempotent, so a retry never spawns a second paid Devin session.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event       TEXT,
  action      TEXT,
  received_at TEXT NOT NULL
);
`;

/**
 * Columns added after the first deployment. `CREATE TABLE IF NOT EXISTS` does
 * nothing to a table that already exists, so a database written by an earlier
 * build needs these added explicitly — otherwise the demo database has to be
 * thrown away to pick up a new field, and throwing away the audit trail to get
 * a schema change is not a trade this system should ever make.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['remediations', 'pr_state', 'TEXT'],
  ['remediations', 'pr_opened_at', 'TEXT'],
  ['remediations', 'pr_merged_at', 'TEXT'],
  ['remediations', 'ci_status', 'TEXT'],
  ['remediations', 'reworks', 'INTEGER NOT NULL DEFAULT 0'],
  ['remediations', 'pr_checked_at', 'TEXT'],
  ['remediations', 'ci_run_id', 'INTEGER'],
  ['remediations', 'merge_requested_at', 'TEXT'],
  ['remediations', 'merge_escalated_at', 'TEXT'],
];

type Row = Record<string, unknown>;

const nowIso = () => new Date().toISOString();

function toRemediation(r: Row): Remediation {
  return {
    id: r.id as number,
    repo: r.repo as string,
    issueNumber: r.issue_number as number,
    issueUrl: (r.issue_url as string) ?? '',
    title: r.title as string,
    contractId: (r.contract_id as string) ?? null,
    category: (r.category as string) ?? null,
    severity: (r.severity as string) ?? null,
    state: r.state as RemediationState,
    devinSessionId: (r.devin_session_id as string) ?? null,
    devinSessionUrl: (r.devin_session_url as string) ?? null,
    prUrl: (r.pr_url as string) ?? null,
    prState: (r.pr_state as Remediation['prState']) ?? null,
    prOpenedAt: (r.pr_opened_at as string) ?? null,
    prMergedAt: (r.pr_merged_at as string) ?? null,
    ciStatus: (r.ci_status as Remediation['ciStatus']) ?? null,
    ciRunId: (r.ci_run_id as number) ?? null,
    reworks: (r.reworks as number) ?? 0,
    mergeRequestedAt: (r.merge_requested_at as string) ?? null,
    mergeEscalatedAt: (r.merge_escalated_at as string) ?? null,
    structuredOutput: r.structured_output ? safeParse(r.structured_output as string) : null,
    attempt: r.attempt as number,
    error: (r.error as string) ?? null,
    acuUsed: (r.acu_used as number) ?? null,
    triggeredBy: (r.triggered_by as string) ?? 'unknown',
    createdAt: r.created_at as string,
    dispatchedAt: (r.dispatched_at as string) ?? null,
    completedAt: (r.completed_at as string) ?? null,
    updatedAt: r.updated_at as string,
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    for (const [table, column, ddl] of ADDED_COLUMNS) {
      const present = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(
        (c) => c.name === column,
      );
      if (!present) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  close(): void {
    this.db.close();
  }

  // --- webhook idempotency -------------------------------------------------

  /** Returns false if this delivery UUID was already processed. */
  recordDelivery(deliveryId: string, event: string, action: string): boolean {
    const existing = this.db
      .prepare('SELECT 1 FROM webhook_deliveries WHERE delivery_id = ?')
      .get(deliveryId);
    if (existing) return false;
    this.db
      .prepare(
        'INSERT INTO webhook_deliveries (delivery_id, event, action, received_at) VALUES (?, ?, ?, ?)',
      )
      .run(deliveryId, event, action, nowIso());
    return true;
  }

  // --- remediations --------------------------------------------------------

  /**
   * Returns the live (non-terminal) remediation for an issue, if any. The
   * dispatcher uses this to avoid opening a second session for an issue that
   * is already being worked — the single most expensive mistake this system
   * could make.
   */
  findActiveByIssue(repo: string, issueNumber: number): Remediation | null {
    const row = this.db
      .prepare(
        `SELECT * FROM remediations
          WHERE repo = ? AND issue_number = ?
            AND state NOT IN ('succeeded','failed','timed_out','cancelled')
          ORDER BY attempt DESC LIMIT 1`,
      )
      .get(repo, issueNumber) as Row | undefined;
    return row ? toRemediation(row) : null;
  }

  /**
   * Any attempt on this issue that produced a pull request still in play.
   *
   * Deliberately not "the latest attempt" — that is the bug this replaced. The
   * attempt that opened the PR is often *not* the newest row: a later attempt
   * that was cancelled, or that correctly declined to open a duplicate, sits
   * on top of it. Asking only the newest row therefore reports "no pull
   * request" for an issue that demonstrably has one, and the scanner
   * re-dispatches it every sweep.
   */
  findLivePullRequestForIssue(repo: string, issueNumber: number): Remediation | null {
    const row = this.db
      .prepare(
        `SELECT * FROM remediations
          WHERE repo = ? AND issue_number = ?
            AND pr_url IS NOT NULL AND pr_url != ''
            AND (pr_state IS NULL OR pr_state != 'closed')
          ORDER BY attempt DESC LIMIT 1`,
      )
      .get(repo, issueNumber) as Row | undefined;
    return row ? toRemediation(row) : null;
  }

  findLatestByIssue(repo: string, issueNumber: number): Remediation | null {
    const row = this.db
      .prepare(
        'SELECT * FROM remediations WHERE repo = ? AND issue_number = ? ORDER BY attempt DESC LIMIT 1',
      )
      .get(repo, issueNumber) as Row | undefined;
    return row ? toRemediation(row) : null;
  }

  get(id: number): Remediation | null {
    const row = this.db.prepare('SELECT * FROM remediations WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row ? toRemediation(row) : null;
  }

  create(input: {
    repo: string;
    issueNumber: number;
    issueUrl: string;
    title: string;
    contractId: string | null;
    category: string | null;
    severity: string | null;
    triggeredBy: string;
    attempt?: number;
  }): Remediation {
    const ts = nowIso();
    const attempt =
      input.attempt ??
      ((
        this.db
          .prepare('SELECT COALESCE(MAX(attempt), 0) AS m FROM remediations WHERE repo = ? AND issue_number = ?')
          .get(input.repo, input.issueNumber) as Row
      ).m as number) + 1;

    const info = this.db
      .prepare(
        `INSERT INTO remediations
          (repo, issue_number, issue_url, title, contract_id, category, severity,
           state, attempt, triggered_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(
        input.repo,
        input.issueNumber,
        input.issueUrl,
        input.title,
        input.contractId,
        input.category,
        input.severity,
        attempt,
        input.triggeredBy,
        ts,
        ts,
      );

    const created = this.get(Number(info.lastInsertRowid))!;
    this.appendEvent({
      remediationId: created.id,
      issueNumber: created.issueNumber,
      type: 'remediation.created',
      toState: 'queued',
      detail: { triggeredBy: input.triggeredBy, contractId: input.contractId, attempt },
    });
    return created;
  }

  /**
   * The only way state changes. Writing the transition and the event in one
   * call is what keeps the audit log honest — there is no path that mutates
   * state without leaving a trace.
   */
  transition(
    id: number,
    to: RemediationState,
    patch: Partial<{
      devinSessionId: string;
      devinSessionUrl: string;
      prUrl: string;
      structuredOutput: unknown;
      error: string | null;
      acuUsed: number;
    }> = {},
    detail: unknown = {},
  ): Remediation {
    const current = this.get(id);
    if (!current) throw new Error(`remediation ${id} not found`);
    const ts = nowIso();

    const sets: string[] = ['state = ?', 'updated_at = ?'];
    const args: unknown[] = [to, ts];

    if (patch.devinSessionId !== undefined) {
      sets.push('devin_session_id = ?');
      args.push(patch.devinSessionId);
    }
    if (patch.devinSessionUrl !== undefined) {
      sets.push('devin_session_url = ?');
      args.push(patch.devinSessionUrl);
    }
    if (patch.prUrl !== undefined) {
      sets.push('pr_url = ?');
      args.push(patch.prUrl);
    }
    if (patch.structuredOutput !== undefined) {
      sets.push('structured_output = ?');
      args.push(JSON.stringify(patch.structuredOutput));
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      args.push(patch.error);
    }
    if (patch.acuUsed !== undefined) {
      sets.push('acu_used = ?');
      args.push(patch.acuUsed);
    }
    if (to === 'dispatching' && !current.dispatchedAt) {
      sets.push('dispatched_at = ?');
      args.push(ts);
    }
    if (['succeeded', 'failed', 'timed_out', 'cancelled'].includes(to)) {
      sets.push('completed_at = ?');
      args.push(ts);
    }

    args.push(id);
    this.db.prepare(`UPDATE remediations SET ${sets.join(', ')} WHERE id = ?`).run(...(args as never[]));

    this.appendEvent({
      remediationId: id,
      issueNumber: current.issueNumber,
      type: 'remediation.transition',
      fromState: current.state,
      toState: to,
      detail,
    });
    return this.get(id)!;
  }

  /**
   * Record what GitHub says about the pull request.
   *
   * Deliberately not a state transition: whether the PR was merged is a fact
   * about the organisation's response, not about the remediation's own
   * lifecycle, and conflating the two is how "the agent finished" turns into
   * "the fix shipped" on a dashboard.
   *
   * `pr_opened_at` is written once and never revised — it is the endpoint of
   * time-to-fix, and a later event must not be allowed to move it.
   */
  recordPullRequest(
    id: number,
    pr: { url?: string; state: PullRequestState; mergedAt?: string | null },
  ): Remediation {
    const current = this.get(id);
    if (!current) throw new Error(`remediation ${id} not found`);
    const ts = nowIso();

    const sets = ['pr_state = ?', 'updated_at = ?'];
    const args: unknown[] = [pr.state, ts];

    if (pr.url) {
      sets.push('pr_url = ?');
      args.push(pr.url);
    }
    if (!current.prOpenedAt) {
      sets.push('pr_opened_at = ?');
      args.push(ts);
    }
    if (pr.state === 'merged') {
      sets.push('pr_merged_at = ?');
      args.push(pr.mergedAt ?? ts);
    }

    args.push(id);
    this.db.prepare(`UPDATE remediations SET ${sets.join(', ')} WHERE id = ?`).run(...(args as never[]));

    if (current.prState !== pr.state) {
      this.appendEvent({
        remediationId: id,
        issueNumber: current.issueNumber,
        type: `pull_request.${pr.state}`,
        detail: { url: pr.url ?? current.prUrl, from: current.prState },
      });
    }
    return this.get(id)!;
  }

  /**
   * Record the PR's own CI verdict — the check Autopilot does not control.
   *
   * The run id is stored alongside the status because the status alone cannot
   * answer "is this a new result?". Two consecutive failing runs both read
   * `failed`, and without the id the poller either re-sends the first failure
   * forever or misses the second one.
   */
  recordCi(id: number, status: CiStatus, detail: unknown = {}, runId?: number | null): Remediation {
    const current = this.get(id);
    if (!current) throw new Error(`remediation ${id} not found`);
    this.db
      .prepare('UPDATE remediations SET ci_status = ?, ci_run_id = ?, updated_at = ? WHERE id = ?')
      .run(status, runId ?? current.ciRunId ?? null, nowIso(), id);
    this.appendEvent({
      remediationId: id,
      issueNumber: current.issueNumber,
      type: `ci.${status}`,
      detail,
    });
    return this.get(id)!;
  }

  /**
   * Record that Devin was asked to merge, so it is only ever asked once.
   *
   * The stamp is not evidence of a merge, and nothing should read it as one:
   * `pr_state` still comes from GitHub. Its whole job is to keep a poll that
   * runs every fifteen seconds from sending the same instruction forever.
   */
  markMergeRequested(id: number): Remediation {
    const current = this.get(id);
    if (!current) throw new Error(`remediation ${id} not found`);
    const ts = nowIso();
    this.db
      .prepare('UPDATE remediations SET merge_requested_at = ?, updated_at = ? WHERE id = ?')
      .run(ts, ts, id);
    this.appendEvent({
      remediationId: id,
      issueNumber: current.issueNumber,
      type: 'merge.requested',
      detail: { prUrl: current.prUrl, category: current.category },
    });
    return this.get(id)!;
  }

  /**
   * Merges that were asked for and never happened.
   *
   * `requestedBefore` is a grace period, not a timeout on the agent: a session
   * that is going to merge does it in a minute or two, so anything still open
   * well after the request is a refusal, a crash, or a message that never
   * landed. Which of those it is comes from the session, not from here.
   */
  listUnperformedMerges(requestedAtOrBefore: string): Remediation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM remediations
          WHERE merge_requested_at IS NOT NULL
            -- Inclusive, so a zero grace period means "immediately" rather than
            -- "never, if the clock did not tick between the two statements".
            AND merge_requested_at <= ?
            AND merge_escalated_at IS NULL
            AND devin_session_id IS NOT NULL
            AND (pr_state IS NULL OR pr_state = 'open')
          ORDER BY merge_requested_at ASC`,
      )
      .all(requestedAtOrBefore) as Row[];
    return rows.map(toRemediation);
  }

  /** Record that the unperformed merge was handed to a human. */
  markMergeEscalated(id: number, reason: string | null): Remediation {
    const current = this.get(id);
    if (!current) throw new Error(`remediation ${id} not found`);
    const ts = nowIso();
    this.db
      .prepare('UPDATE remediations SET merge_escalated_at = ?, updated_at = ? WHERE id = ?')
      .run(ts, ts, id);
    this.appendEvent({
      remediationId: id,
      issueNumber: current.issueNumber,
      type: 'merge.escalated',
      detail: { prUrl: current.prUrl, requestedAt: current.mergeRequestedAt, reason },
    });
    return this.get(id)!;
  }

  /** Count a CI-driven self-correction, and return the new total. */
  incrementReworks(id: number): number {
    this.db
      .prepare('UPDATE remediations SET reworks = reworks + 1, updated_at = ? WHERE id = ?')
      .run(nowIso(), id);
    return this.get(id)?.reworks ?? 0;
  }

  /**
   * Remediations whose pull request has not yet reached a resting place.
   *
   * The reconciler polls these so merge rate stays correct even when no
   * webhook is configured — a demo without a public tunnel should still
   * produce honest numbers.
   */
  listAwaitingPullRequestOutcome(): Remediation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM remediations
          WHERE pr_url IS NOT NULL AND pr_url != ''
            AND (pr_state IS NULL OR pr_state = 'open')
          ORDER BY updated_at ASC`,
      )
      .all() as Row[];
    return rows.map(toRemediation);
  }

  /**
   * Finished remediations that have a session but no pull request recorded.
   *
   * Two things live in here: genuine no-change outcomes, and work whose PR we
   * failed to record. Only the provider can tell them apart, which is why this
   * is a list to go and ask about rather than a number to report.
   *
   * Each row is offered once — `pr_checked_at` is stamped whether or not a PR
   * turned up. A finished session's output does not change, so re-asking every
   * tick would be a standing API call per historical remediation, forever.
   */
  listTerminalWithoutPullRequest(): Remediation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM remediations
          WHERE state IN ('succeeded','failed','timed_out')
            AND devin_session_id IS NOT NULL
            AND (pr_url IS NULL OR pr_url = '')
            AND pr_checked_at IS NULL
          ORDER BY updated_at DESC`,
      )
      .all() as Row[];
    return rows.map(toRemediation);
  }

  markPullRequestChecked(id: number): void {
    this.db.prepare('UPDATE remediations SET pr_checked_at = ? WHERE id = ?').run(nowIso(), id);
  }

  /** Find the remediation that owns a pull request, newest attempt first. */
  findByPullRequest(url: string): Remediation | null {
    const row = this.db
      .prepare('SELECT * FROM remediations WHERE pr_url = ? ORDER BY attempt DESC LIMIT 1')
      .get(url) as Row | undefined;
    return row ? toRemediation(row) : null;
  }

  listByState(states: RemediationState[]): Remediation[] {
    if (!states.length) return [];
    const holes = states.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM remediations WHERE state IN (${holes}) ORDER BY created_at ASC`)
      .all(...(states as never[])) as Row[];
    return rows.map(toRemediation);
  }

  listAll(limit = 200): Remediation[] {
    const rows = this.db
      .prepare('SELECT * FROM remediations ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map(toRemediation);
  }

  countActive(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM remediations
          WHERE state IN ('queued','dispatching','running','blocked')`,
      )
      .get() as Row;
    return row.c as number;
  }

  // --- events --------------------------------------------------------------

  appendEvent(e: {
    remediationId?: number | null;
    issueNumber?: number | null;
    type: string;
    fromState?: string | null;
    toState?: string | null;
    detail?: unknown;
  }): void {
    this.db
      .prepare(
        `INSERT INTO events (remediation_id, issue_number, type, from_state, to_state, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.remediationId ?? null,
        e.issueNumber ?? null,
        e.type,
        e.fromState ?? null,
        e.toState ?? null,
        JSON.stringify(e.detail ?? {}),
        nowIso(),
      );
  }

  listEvents(limit = 100): AutopilotEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      remediationId: (r.remediation_id as number) ?? null,
      issueNumber: (r.issue_number as number) ?? null,
      type: r.type as string,
      fromState: (r.from_state as string) ?? null,
      toState: (r.to_state as string) ?? null,
      detail: r.detail ? safeParse(r.detail as string) : {},
      createdAt: r.created_at as string,
    }));
  }

  /** Escape hatch for the analytics layer, which is read-only by design. */
  query(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(params as never[])) as Row[];
  }
}

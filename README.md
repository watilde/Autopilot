# Autopilot

**Event-driven issue remediation for [Apache Superset](https://github.com/apache/superset), powered by the [Devin API](https://docs.devin.ai/api-reference/overview).**

Label a GitHub issue `autopilot`. A verified pull request shows up. Every step is
measured.

- **Solution repo:** this one
- **Target fork:** [`watilde/superset`](https://github.com/watilde/superset) — [the five seeded issues](https://github.com/watilde/superset/issues)

---

## The problem

Every engineering org has a backlog of defects nobody argues about: an unsafe
YAML loader, an MD5 call that crashes on FIPS hosts, the same broken ID
generator copy-pasted into three files. They are small, real, and individually
worth maybe forty minutes. They are also *never worth interrupting a roadmap
for*, so they sit in the backlog for years — until one of them becomes an
incident.

The blocker isn't capability. It's **activation energy**: context-switch, clone,
reproduce, fix, verify, open a PR, wait for review. Nobody spends their Tuesday
on `@ts-ignore`.

Autopilot removes the activation energy. Triage stays human — someone decides
the issue is real and worth fixing. Everything after that is automated, and the
result lands as a normal pull request in a normal review queue.

## What it is not

It is **not** "point an agent at a repo and hope". Three constraints make it
something you could actually run against a real codebase:

1. **No contract, no dispatch.** An issue must carry a machine-readable
   `autopilot` block naming the defect, the acceptance criteria, and the shell
   commands that prove the fix. A stray label on a vague issue is refused, with
   a comment explaining why.
2. **Devin's own verification gates the result.** Every session runs the
   contract's `verify` commands and reports their real output. A finished
   session that opened no PR, or whose verification failed, is recorded as a
   **failure** — not a success.
3. **A human still merges.** Autopilot's output is a pull request, not a push to
   `master`. The system never has write access to a protected branch.

---

## Architecture

```
  TRIGGERS                    ORCHESTRATOR                   EXTERNAL
  ─────────                   ────────────                   ────────

  GitHub webhook  ──┐
  issues.labeled    │        ┌──────────────┐
                    ├──────► │   intake()   │  contract valid? already running?
  Scheduled scan  ──┤        └──────┬───────┘
  every 60s         │               │ queued
                    │               ▼
  POST /api/trigger ┘        ┌──────────────┐   POST …/sessions
                             │  dispatch()  │ ──────────────────────►  Devin
                             └──────┬───────┘   prompt + JSON schema   v1 or v3
                                    │ running                            │
                                    ▼                                    │
                             ┌──────────────┐   GET …/sessions/{id}      │
                             │ reconcile()  │ ◄──────────────────────────┘
                             └──────┬───────┘   every 15s, normalised
                                    │
                     ┌──────────────┼──────────────┐
                     ▼              ▼              ▼
                 succeeded       failed         blocked        ──► PR on the fork
                     │              │              │           ──► status comment
                     └──────────────┴──────────────┘           ──► labels
                                    │
                                    ▼
                        SQLite: remediations + append-only event log
                                    │
                     ┌──────────────┼──────────────┐
                     ▼              ▼              ▼
                 dashboard      /metrics       npm run report
                    /          Prometheus         terminal
```

### Why it's shaped this way

**Intake and dispatch are separate.** Webhooks arrive in bursts — a scan
finishes and labels nine issues at once — and every Devin session costs real
money. Accepting work and starting work have to be decoupled so the queue
absorbs the burst and `MAX_CONCURRENT_SESSIONS` controls spend.

**Reconciliation is a poll loop, not a callback.** A webhook you never receive
is indistinguishable from one that says nothing happened. The loop is what
guarantees a session can't sit in `running` forever because a notification was
dropped, and it's what enforces `SESSION_TIMEOUT_MS`.

**Two triggers, one intake path.** The webhook is the fast path; the periodic
scan is the safety net for deliveries dropped during a restart. Both call
`intake()`, and `intake()` deduplicates, so a webhook and a scan racing on the
same issue is harmless by construction.

**Structured output, not prose.** Sessions are created with a
`structured_output_schema`, so completion arrives as data — `status`,
`files_changed`, `verification_passed`, `pull_request_url`, `confidence`. The
orchestrator decides success programmatically instead of regex-matching an
agent's summary.

**The event log is the source of truth.** Every state transition appends a row.
Metrics are derived from it, which means the numbers survive a restart and are
auditable after an incident.

---

## Quickstart

### Docker (no credentials needed)

```bash
git clone https://github.com/watilde/Autopilot.git && cd Autopilot
docker compose up --build -d

# fire five signed webhooks and watch them through to completion
npm install && npm run simulate

open http://localhost:8080
```

Defaults to `DEVIN_MODE=mock` — a deterministic in-process simulator that
exercises the entire pipeline (signature check, contract parse, dispatch,
reconcile, metrics) without an API key and without spending ACUs. It reproduces
the awkward states too: blocked, expired, and a session that finishes without
opening a PR.

### Local

```bash
npm install
cp .env.example .env
npm run dev          # http://localhost:8080
npm run simulate     # in another terminal
npm run report       # terminal summary
```

### Live mode

```bash
# .env
DEVIN_MODE=live
DEVIN_API_KEY=cog_...             # or a legacy apk_ key
DEVIN_ORG_ID=org-...              # required for cog_ keys; see below
GITHUB_TOKEN=ghp_...              # `repo` scope: read issues, post comments
GITHUB_WEBHOOK_SECRET=...         # shared secret from the GitHub webhook
ALLOW_UNSIGNED_WEBHOOKS=false
```

**Both Devin API generations are supported, and the right one is inferred from
your credential:**

| Key prefix | API | Notes |
|---|---|---|
| `cog_…` | **v3** (current) | Service-user credential. Every path is org-scoped, so `DEVIN_ORG_ID` is required — find it under *Settings → Service Users*. |
| `apk_…` / `apk_user_…` | v1 (deprecated) | No org id needed. |

Getting this wrong fails with a bare `403 Unauthorized` and no explanation, so
Autopilot infers the generation from the key prefix, logs which one it chose,
and refuses to boot with an actionable message if a `cog_` key is missing its
org id. Override with `DEVIN_API_VERSION` if you ever need to.

The two generations disagree about nearly everything the orchestrator cares
about — v1 has `status_enum`, one `pull_request` and no cost field; v3 splits
lifecycle across `status` + `status_detail`, returns a `pull_requests` array and
reports `acus_consumed`. Each client normalises into one internal shape, so the
state machine never learns either dialect.

Point a GitHub webhook at `https://<host>/webhooks/github` — content type
`application/json`, events **Issues** and **Issue comments** — then label an
issue `autopilot`.

Without a public host, use the scheduled scanner or trigger directly:

```bash
curl -X POST localhost:8080/api/trigger \
     -H 'content-type: application/json' -d '{"issueNumber": 1}'
```

---

## The remediation backlog

Five issues seeded into [`watilde/superset`](https://github.com/watilde/superset/issues)
via `npm run seed`. **All five were found by reading the actual Superset source** —
every path, line number and excerpt was manually verified before being written
down. (Two candidates were discarded during the scan: a `requests.post` that
looked timeout-less until the continuation line showed `timeout=60`, and the
migration-script bare `except:` clauses, which are frozen historical files.)

| ID | Issue | Category | Why it's real |
|----|-------|----------|---------------|
| [SEC-001](https://github.com/watilde/superset/issues/1) | `yaml.load` with full `yaml.Loader` in the examples importer | security | CWE-502. `# noqa: S506` suppresses Bandit rather than fixing it. |
| [SEC-002](https://github.com/watilde/superset/issues/2) | `hashlib.md5()` without `usedforsecurity=False` | security | **A crash, not a nit** — raises `ValueError` on FIPS-enabled hosts. Both sites are explicitly non-cryptographic. |
| [QUAL-001](https://github.com/watilde/superset/issues/3) | `Math.random()` ID generation duplicated across 3 files | code-quality | `.substring(2,15)` doesn't reliably yield 13 chars; these IDs are React reconciliation keys. |
| [DEP-001](https://github.com/watilde/superset/issues/4) | Audit the `setuptools<81` ceiling | dependency | The pin names a condition for lifting it, but nobody recorded which deps still import `pkg_resources`. |
| [QUAL-002](https://github.com/watilde/superset/issues/5) | `@ts-ignore` → `@ts-expect-error` | code-quality | The entire remaining population in `src` — closing it lets a lint rule hold the line. |

The mix is deliberate: two security fixes, two code-quality changes, and one
investigation whose deliverable is a written audit rather than a code change —
because "produce evidence" is a real category of work an agent is good at.

### The contract

Each issue body carries a fenced block that Autopilot parses:

````markdown
```autopilot
id: SEC-001
category: security
severity: high
targets:
  - superset/examples/utils.py:261
acceptance:
  - "yaml.load(..., Loader=yaml.Loader) is replaced with yaml.safe_load(...)"
  - "No other call sites or files are modified"
verify:
  - "python -m compileall -q superset/examples/utils.py"
  - "! grep -q 'Loader=yaml.Loader' superset/examples/utils.py"
  - "ruff check superset/examples/utils.py"
notes: |
  Keep the change to the single statement.
```
````

This is the whole safety model. `verify` commands are fast and hermetic — lint,
byte-compile, targeted unit tests, greps — never the full Superset suite, which
needs a database and many minutes.

---

## Observability

> *"If I were an engineering leader, how would I know this is working?"*

Counting sessions doesn't answer that — a system can start a hundred sessions and
ship nothing. So the metrics are outcome-shaped.

| Surface | What it's for |
|---|---|
| `GET /` | Live dashboard, 5s refresh |
| `GET /metrics` | Prometheus — for alerting |
| `GET /api/analytics` | Full JSON snapshot |
| `npm run report` | Terminal report, reads SQLite directly — works when the service is down |
| Issue comments | Status back to whoever filed the bug |

**The numbers that matter:**

- **Pull requests opened** — merge-ready output, not tasks attempted.
- **Success rate over *completed* work.** In-flight items are excluded from the
  denominator; otherwise labelling a new issue would make the system look worse.
- **Median and p90 cycle time** — the tail is what people feel.
- **ACUs per pull request** — a defensible unit cost.
- **False positives, tracked separately.** A well-argued "this report was wrong"
  is a success that produces no PR, and conflating it with a shipped fix would
  corrupt both numbers.
- **Grouped failure reasons** — so the next improvement is obvious.

```
  OUTCOMES
    pull requests opened .... 3
    success rate ............ 80%  (of 5 completed)
    false positives ......... 1  (reports correctly rejected)
    failed .................. 1

  COST
    ACUs per pull request ... 2.0

  BY CATEGORY
    security       ████████████████████████   2 total, 0 PR, 50% success
    code-quality   ████████████████████████   2 total, 2 PR, 100% success
```

---

## Why Devin specifically

Two properties of this workload rule out the cheaper options.

**The unit of work is a session, not a completion.** SEC-002 requires editing two
files in different modules, running `pytest`, reading the failure, and iterating.
DEP-001 requires walking a dependency tree, checking upstream release notes, and
writing a reasoned recommendation. Neither is a diff you can generate in one
shot — they need a machine that can run commands and respond to what comes back.

**Verification has to happen where the code runs.** The contract's value is that
`ruff check` and `pytest` actually execute before the PR opens. A model without
an environment can only *claim* the tests pass. Devin's sandbox is what turns
"the agent thinks it fixed it" into "the commands exited 0, here is the output".

A scripted codemod could handle SEC-001 and QUAL-002. It could not handle
QUAL-001 (design a shared helper, write its tests, update three call sites) or
DEP-001 (investigate and reach a judgement). The point of the contract format is
that *the same pipeline* handles all four.

---

## Design notes

**Idempotency at three layers.** GitHub retries deliveries, so delivery UUIDs are
recorded and replays short-circuit. Intake refuses an issue that already has a
non-terminal remediation. Sessions are created with `idempotent: true` as
defence in depth at the provider. Duplicate work is the most expensive mistake
this system could make.

**HMAC over raw bytes.** The webhook endpoint is the only unauthenticated entry
point, and a forgery would let anyone spend the Devin budget. The server keeps
`rawBody` and verifies against it — re-serialising the parsed JSON changes the
bytes and breaks the digest. Comparison is constant-time; malformed input is
rejected cleanly rather than throwing.

**Autopilot never writes code.** It reads issues and posts comments. Devin pushes
branches and opens PRs through its own GitHub integration. That keeps the token
small and the trust boundary easy to describe in review.

**Failure is a first-class state.** `blocked` surfaces Devin's question on the
issue and waits. `timed_out` is enforced by the reconciler. Transport errors
requeue; 4xx errors terminate. A finished-but-no-PR session fails loudly.

**Zero native dependencies.** Persistence uses Node 24's built-in `node:sqlite`,
so there's no `node-gyp` in the build and no compiler in the runtime image.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DEVIN_MODE` | `mock` | `live` calls the real API |
| `DEVIN_API_KEY` | — | required when live |
| `DEVIN_MAX_ACU` | `10` | per-session ceiling; a runaway task can't silently burn budget |
| `GITHUB_TOKEN` | — | `repo` scope |
| `GITHUB_WEBHOOK_SECRET` | — | required unless `ALLOW_UNSIGNED_WEBHOOKS=true` |
| `AUTOPILOT_LABEL` | `autopilot` | the label that arms an issue |
| `MAX_CONCURRENT_SESSIONS` | `3` | backpressure on spend |
| `RECONCILE_INTERVAL_MS` | `15000` | poll cadence |
| `SESSION_TIMEOUT_MS` | `3600000` | after this, fail and terminate |

Full list in [`.env.example`](.env.example).

## API

| Method | Path | |
|---|---|---|
| `POST` | `/webhooks/github` | HMAC-verified ingress |
| `POST` | `/api/trigger` | manual trigger — `{"issueNumber": 1}` |
| `POST` | `/api/scan` | force a scheduled sweep |
| `POST` | `/api/tick` | force a reconcile pass |
| `GET` | `/api/analytics` \| `/api/remediations` \| `/api/events` | reporting |
| `GET` | `/healthz` \| `/metrics` | ops |

Operators can also comment `/autopilot retry` on an issue.

## Tests

```bash
npm test         # 88 tests
npm run typecheck
```

Covering contract parsing and its **refusal** paths, HMAC verification including
malformed input, delivery idempotency, the concurrency cap, the full
intake → dispatch → reconcile lifecycle across every terminal state, the
finished-without-PR judgement, and analytics arithmetic (including that success
rate is computed over completed work only).

## Extending this

- **More triggers.** Dependabot alerts, CodeQL results, Sentry issues — anything
  that can produce a contract. Intake doesn't care where an issue came from.
- **Playbooks.** Devin `playbook_id` per category, so security fixes follow a
  reviewed procedure.
- **Close the loop on review.** Feed PR review comments back via
  `POST /sessions/{id}/messages` so Devin addresses feedback in-session.
- **Auto-merge the trivial tier.** QUAL-002-class changes with green CI and high
  confidence could merge unattended; SEC-* never should.
- **Cost governance.** ACU budgets per team, with the dashboard showing spend
  against them.

## Layout

```
src/
  config.ts          env validation — fails at boot, not at 3am
  core/
    contract.ts      the ```autopilot parser (the safety gate)
    prompt.ts        deterministic prompt + structured output schema
    orchestrator.ts  intake / dispatch / reconcile
    scanner.ts       periodic sweep
  devin/
    client-v1.ts     deprecated v1 API (apk_ keys)
    client-v3.ts     current v3 API (cog_ keys, org-scoped)
    http.ts          shared transport: retry, jittered backoff
    mock.ts          deterministic simulator
  github/
    webhook.ts       HMAC verification
  obs/
    metrics.ts       Prometheus
    analytics.ts     outcome-shaped reporting
scripts/
  issues.ts          the five contracts
  seed-issues.ts     create labels + issues
  simulate.ts        end-to-end demo driver
  report.ts          terminal report
```

## Licence

MIT — see [LICENSE](LICENSE).
